/**
 * Data Consistency Checker Module
 * Checks and fixes inconsistencies between chat history files and agent topic lists
 * Also detects and recovers orphaned agents (topic files exist but agent config is missing)
 */

class ConsistencyChecker {
    constructor(appDataPath, apiHandlers) {
        this.appDataPath = appDataPath;
        this.api = apiHandlers;
        this.issues = [];
    }

    /**
     * Perform a full consistency check
     * @param {Object} agents - All agents data
     * @param {Object} groups - All groups data
     * @returns {Object} Check results with issues found
     */
    async performCheck(agents, groups) {
        this.issues = [];
        
        // Phase 1: Check existing agents/groups for topic inconsistencies
        for (const [agentId, agentData] of Object.entries(agents)) {
            await this.checkItem(agentId, agentData, 'agent');
        }
        
        for (const [groupId, groupData] of Object.entries(groups)) {
            await this.checkItem(groupId, groupData, 'group');
        }
        
        // Phase 2: Check for orphaned agents (topic files exist but agent config is missing)
        await this.checkOrphanedAgents(agents, groups);
        
        return {
            totalIssues: this.issues.length,
            issues: this.issues
        };
    }

    /**
     * Check a single agent or group for consistency
     */
    async checkItem(itemId, itemData, itemType) {
        const userDataPath = `${this.appDataPath}UserData/${itemId}/topics`;
        
        try {
            // Get actual topic directories from filesystem
            const actualTopicDirs = await this.api.listDir(userDataPath);
            
            if (!actualTopicDirs || actualTopicDirs.length === 0) {
                // No topics directory exists, but config might have topics
                if (itemData.topics && itemData.topics.length > 0) {
                    this.issues.push({
                        itemId,
                        itemName: itemData.name,
                        itemType,
                        type: 'missing_all_files',
                        message: `Config has ${itemData.topics.length} topics but no topic directory exists`,
                        configTopics: itemData.topics,
                        fileTopics: []
                    });
                }
                return;
            }
            
            // Get topics from config
            const configTopics = itemData.topics || [];
            const configTopicIds = new Set(configTopics.map(t => t.id));
            const fileTopicIds = new Set(actualTopicDirs);
            
            // Find topics in config but not in filesystem
            const missingFiles = configTopics.filter(t => !fileTopicIds.has(t.id));
            if (missingFiles.length > 0) {
                this.issues.push({
                    itemId,
                    itemName: itemData.name,
                    itemType,
                    type: 'missing_files',
                    message: `${missingFiles.length} topic(s) in config but missing files`,
                    missingTopics: missingFiles
                });
            }
            
            // Find topics in filesystem but not in config
            const orphanedFiles = actualTopicDirs.filter(dirName => !configTopicIds.has(dirName));
            if (orphanedFiles.length > 0) {
                // Try to read history files to get topic names
                const orphanedTopicsWithData = await Promise.all(
                    orphanedFiles.map(async (topicId) => {
                        const historyPath = `${userDataPath}/${topicId}/history.json`;
                        try {
                            const historyStr = await this.api.readFile(historyPath);
                            if (historyStr) {
                                const history = JSON.parse(historyStr);
                                // Try to infer topic name from first message or use ID
                                return {
                                    id: topicId,
                                    name: `Recovered: ${topicId}`,
                                    createdAt: history[0]?.timestamp || Date.now(),
                                    messageCount: history.length
                                };
                            }
                        } catch (e) {
                            console.warn(`Could not read history for orphaned topic ${topicId}`);
                        }
                        return {
                            id: topicId,
                            name: `Unknown: ${topicId}`,
                            createdAt: Date.now(),
                            messageCount: 0
                        };
                    })
                );
                
                this.issues.push({
                    itemId,
                    itemName: itemData.name,
                    itemType,
                    type: 'orphaned_files',
                    message: `${orphanedFiles.length} topic file(s) exist but not in config`,
                    orphanedTopics: orphanedTopicsWithData
                });
            }
            
        } catch (error) {
            console.error(`Error checking consistency for ${itemType} ${itemId}:`, error);
            this.issues.push({
                itemId,
                itemName: itemData.name,
                itemType,
                type: 'check_error',
                message: `Error during check: ${error.message}`,
                error: error.message
            });
        }
    }

    /**
     * Phase 2: Check for orphaned agents - UserData directories that have no corresponding Agent config
     * This detects the case where topic files still exist but the agent's config.json was lost
     */
    async checkOrphanedAgents(existingAgents, existingGroups) {
        try {
            // Get all directories in UserData
            const userDataDirs = await this.api.listDir(`${this.appDataPath}UserData`);
            if (!userDataDirs || userDataDirs.length === 0) return;

            // Build sets of known agent/group IDs
            const knownAgentIds = new Set(Object.keys(existingAgents));
            const knownGroupIds = new Set(Object.keys(existingGroups));

            // Also check which agent config directories actually exist
            const agentConfigDirs = await this.api.listDir(`${this.appDataPath}Agents`) || [];
            const agentConfigDirSet = new Set(agentConfigDirs);

            const groupConfigDirs = await this.api.listDir(`${this.appDataPath}AgentGroups`) || [];
            const groupConfigDirSet = new Set(groupConfigDirs);

            for (const dirName of userDataDirs) {
                // Skip non-agent directories (like 'attachments', files, etc.)
                if (dirName === 'attachments' || dirName === 'user_avatar.png') continue;

                // Check if this UserData directory has a topics subdirectory
                const topicsPath = `${this.appDataPath}UserData/${dirName}/topics`;
                const topicDirs = await this.api.listDir(topicsPath);
                
                if (!topicDirs || topicDirs.length === 0) continue; // No topic files, skip

                // Check if this directory belongs to a known agent or group
                const isKnownAgent = knownAgentIds.has(dirName);
                const isKnownGroup = knownGroupIds.has(dirName);
                const hasAgentConfig = agentConfigDirSet.has(dirName);
                const hasGroupConfig = groupConfigDirSet.has(dirName);

                if (!isKnownAgent && !isKnownGroup && !hasAgentConfig && !hasGroupConfig) {
                    // This is an orphaned agent! Topic files exist but no config
                    const recoveryInfo = await this.extractRecoveryInfo(dirName, topicDirs, topicsPath);
                    
                    this.issues.push({
                        itemId: dirName,
                        itemName: recoveryInfo.agentName || `Unknown (${dirName})`,
                        itemType: 'orphaned_agent',
                        type: 'missing_agent_config',
                        message: `Found ${topicDirs.length} topic(s) with chat history but agent config is missing`,
                        recoveryInfo: recoveryInfo,
                        topicDirs: topicDirs
                    });
                }
            }
        } catch (error) {
            console.error('Error checking for orphaned agents:', error);
        }
    }

    /**
     * Extract recovery information from chat history files
     * Reads history.json files to find agent name, topic info, etc.
     */
    async extractRecoveryInfo(agentId, topicDirs, topicsPath) {
        const info = {
            agentId: agentId,
            agentName: null,
            topics: [],
            totalMessages: 0,
            oldestTimestamp: null,
            newestTimestamp: null,
            // Fields we try to recover
            model: null,
            systemPromptHint: null
        };

        const nameVotes = {}; // Collect name candidates and vote on them

        for (const topicId of topicDirs) {
            const historyPath = `${topicsPath}/${topicId}/history.json`;
            let topicInfo = {
                id: topicId,
                name: `Recovered: ${topicId}`,
                createdAt: Date.now(),
                messageCount: 0
            };

            try {
                const historyStr = await this.api.readFile(historyPath);
                if (!historyStr) continue;

                const history = JSON.parse(historyStr);
                if (!Array.isArray(history) || history.length === 0) continue;

                topicInfo.messageCount = history.length;
                info.totalMessages += history.length;

                // Extract timestamps
                const firstMsg = history[0];
                const lastMsg = history[history.length - 1];
                
                if (firstMsg && firstMsg.timestamp) {
                    topicInfo.createdAt = firstMsg.timestamp;
                    if (!info.oldestTimestamp || firstMsg.timestamp < info.oldestTimestamp) {
                        info.oldestTimestamp = firstMsg.timestamp;
                    }
                }
                if (lastMsg && lastMsg.timestamp) {
                    if (!info.newestTimestamp || lastMsg.timestamp > info.newestTimestamp) {
                        info.newestTimestamp = lastMsg.timestamp;
                    }
                }

                // Extract agent name from assistant messages
                for (const msg of history) {
                    if (msg.role === 'assistant' && msg.name) {
                        const name = msg.name.trim();
                        if (name) {
                            nameVotes[name] = (nameVotes[name] || 0) + 1;
                        }
                    }
                }

                // Try to extract model info from message metadata (if present)
                for (const msg of history) {
                    if (msg.model && !info.model) {
                        info.model = msg.model;
                    }
                }

                // Try to get topic name from system message or first user message context
                // (topic names are usually set by the user, but we can use topicId as fallback)
                if (topicId === 'default') {
                    topicInfo.name = '主要对话';
                }

            } catch (e) {
                console.warn(`Could not read history for orphaned topic ${topicId} of agent ${agentId}:`, e);
            }

            info.topics.push(topicInfo);
        }

        // Determine the agent name by voting
        if (Object.keys(nameVotes).length > 0) {
            // Pick the name with the most votes
            const sortedNames = Object.entries(nameVotes).sort((a, b) => b[1] - a[1]);
            info.agentName = sortedNames[0][0];
        }

        // Sort topics by createdAt
        info.topics.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

        return info;
    }

    /**
     * Fix issues by updating the config file's topics list
     * This only modifies the topics array, preserving all other config data
     */
    async fixIssues(selectedIssues, fixOptions) {
        const results = [];
        
        // Separate orphaned agent issues from regular issues
        const orphanedAgentIssues = selectedIssues.filter(i => i.type === 'missing_agent_config');
        const regularIssues = selectedIssues.filter(i => i.type !== 'missing_agent_config');

        // Handle orphaned agent recovery
        if (orphanedAgentIssues.length > 0 && fixOptions.recoverOrphanedAgents) {
            for (const issue of orphanedAgentIssues) {
                try {
                    const result = await this.recoverOrphanedAgent(issue);
                    results.push(result);
                } catch (error) {
                    results.push({
                        itemId: issue.itemId,
                        itemType: 'orphaned_agent',
                        success: false,
                        error: error.message
                    });
                }
            }
        }

        // Group regular issues by item
        const issuesByItem = {};
        for (const issue of regularIssues) {
            const key = `${issue.itemType}_${issue.itemId}`;
            if (!issuesByItem[key]) {
                issuesByItem[key] = {
                    itemId: issue.itemId,
                    itemType: issue.itemType,
                    issues: []
                };
            }
            issuesByItem[key].issues.push(issue);
        }
        
        // Fix each item
        for (const [key, itemIssues] of Object.entries(issuesByItem)) {
            try {
                const result = await this.fixItemIssues(itemIssues, fixOptions);
                results.push(result);
            } catch (error) {
                results.push({
                    itemId: itemIssues.itemId,
                    itemType: itemIssues.itemType,
                    success: false,
                    error: error.message
                });
            }
        }
        
        return results;
    }

    /**
     * Recover an orphaned agent by creating a new config.json from chat history data
     */
    async recoverOrphanedAgent(issue) {
        const { itemId, recoveryInfo } = issue;
        const agentName = recoveryInfo.agentName || itemId;

        // Build topics array from recovered info
        const topics = recoveryInfo.topics.map(t => ({
            id: t.id,
            name: t.name,
            createdAt: t.createdAt || Date.now()
        }));

        // Create a minimal but valid agent config
        const newConfig = {
            name: agentName,
            systemPrompt: `你是 ${agentName}。`,
            model: recoveryInfo.model || '',
            temperature: 0.7,
            contextTokenLimit: 1000000,
            maxOutputTokens: 60000,
            topics: topics,
            disableCustomColors: true,
            useThemeColorsInChat: true,
            _recoveredAt: Date.now(),
            _recoveredFrom: 'VchatManager consistency checker'
        };

        // Create the agent config directory and write config.json
        const configDirPath = `${this.appDataPath}Agents/${itemId}`;
        const configFilePath = `${configDirPath}/config.json`;

        // Ensure directory exists
        const ensureResult = await this.api.ensureDir(configDirPath);
        if (ensureResult && !ensureResult.success) {
            throw new Error(`Failed to create agent directory: ${ensureResult.error}`);
        }

        // Write config file
        const writeResult = await this.api.writeFile(
            configFilePath,
            JSON.stringify(newConfig, null, 2)
        );

        if (!writeResult.success) {
            throw new Error(writeResult.error || 'Failed to write agent config');
        }

        // Update settings.json to include this agent in combinedItemOrder
        try {
            await this.addToCombinedItemOrder(itemId, 'agent');
        } catch (e) {
            console.warn(`Could not add recovered agent to combinedItemOrder:`, e);
            // Non-fatal - the agent will still work, just might not appear in order
        }

        return {
            itemId,
            itemType: 'orphaned_agent',
            success: true,
            modified: true,
            recoveredName: agentName,
            topicsCount: topics.length,
            totalMessages: recoveryInfo.totalMessages
        };
    }

    /**
     * Add a recovered item to settings.json combinedItemOrder
     */
    async addToCombinedItemOrder(itemId, itemType) {
        const settingsPath = `${this.appDataPath}settings.json`;
        const settingsStr = await this.api.readFile(settingsPath);
        if (!settingsStr) return; // No settings file, skip

        const settings = JSON.parse(settingsStr);
        if (!settings.combinedItemOrder || !Array.isArray(settings.combinedItemOrder)) {
            settings.combinedItemOrder = [];
        }

        // Check if already in list
        const alreadyExists = settings.combinedItemOrder.some(
            item => item.id === itemId && item.type === itemType
        );

        if (!alreadyExists) {
            settings.combinedItemOrder.push({ type: itemType, id: itemId });
            await this.api.writeFile(settingsPath, JSON.stringify(settings, null, 2));
        }
    }

    /**
     * Fix issues for a single item by safely updating only the topics array
     */
    async fixItemIssues(itemIssues, fixOptions) {
        const { itemId, itemType, issues } = itemIssues;
        const configPath = itemType === 'agent'
            ? `${this.appDataPath}Agents/${itemId}/config.json`
            : `${this.appDataPath}AgentGroups/${itemId}/config.json`;
        
        // Read current config
        const configStr = await this.api.readFile(configPath);
        if (!configStr) {
            throw new Error('Could not read config file');
        }
        
        const config = JSON.parse(configStr);
        let currentTopics = config.topics || [];
        let modified = false;
        
        // Process each issue
        for (const issue of issues) {
            if (issue.type === 'orphaned_files' && fixOptions.addOrphaned) {
                // Add orphaned topics to config
                for (const orphanedTopic of issue.orphanedTopics) {
                    // Check if not already in list
                    if (!currentTopics.find(t => t.id === orphanedTopic.id)) {
                        currentTopics.push({
                            id: orphanedTopic.id,
                            name: orphanedTopic.name,
                            createdAt: orphanedTopic.createdAt
                        });
                        modified = true;
                    }
                }
            }
            
            if (issue.type === 'missing_files' && fixOptions.removeMissing) {
                // Remove topics that don't have files
                const missingIds = new Set(issue.missingTopics.map(t => t.id));
                currentTopics = currentTopics.filter(t => !missingIds.has(t.id));
                modified = true;
            }
        }
        
        if (modified) {
            // Safely update only the topics array
            config.topics = currentTopics;
            
            // Write back to file
            const result = await this.api.writeFile(
                configPath,
                JSON.stringify(config, null, 2)
            );
            
            if (!result.success) {
                throw new Error(result.error || 'Failed to write config');
            }
            
            return {
                itemId,
                itemType,
                success: true,
                modified: true,
                topicsCount: currentTopics.length
            };
        }
        
        return {
            itemId,
            itemType,
            success: true,
            modified: false,
            message: 'No changes needed'
        };
    }

    /**
     * Generate a human-readable report
     */
    generateReport(checkResults) {
        if (checkResults.totalIssues === 0) {
            return {
                summary: '✓ No consistency issues found',
                details: 'All agent and group topic lists match their chat history files.'
            };
        }
        
        const report = {
            summary: `⚠ Found ${checkResults.totalIssues} consistency issue(s)`,
            details: []
        };
        
        for (const issue of checkResults.issues) {
            let detail = `\n[${issue.itemType.toUpperCase()}] ${issue.itemName} (${issue.itemId}):\n`;
            detail += `  ${issue.message}\n`;
            
            if (issue.type === 'orphaned_files') {
                detail += `  Orphaned topics: ${issue.orphanedTopics.map(t => t.id).join(', ')}\n`;
            } else if (issue.type === 'missing_files') {
                detail += `  Missing topics: ${issue.missingTopics.map(t => t.id).join(', ')}\n`;
            } else if (issue.type === 'missing_agent_config') {
                detail += `  Recovered name: ${issue.recoveryInfo.agentName || 'Unknown'}\n`;
                detail += `  Topics found: ${issue.recoveryInfo.topics.length}\n`;
                detail += `  Total messages: ${issue.recoveryInfo.totalMessages}\n`;
            }
            
            report.details.push(detail);
        }
        
        return report;
    }
}

// Export for use in script.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ConsistencyChecker;
}