const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

// Load environment variables
require('dotenv').config();

// Configuration
const AGENT_DIR = process.env.AGENT_DIR || path.join(__dirname, '..', '..', '..', 'AppData', 'Agents');
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

// Get reference to main process IPC (if available)
let mainProcessIPC = null;
try {
    // Try to get ipcMain from electron (only works if we're in main process context)
    const { ipcMain } = require('electron');
    if (ipcMain) {
        mainProcessIPC = ipcMain;
    }
} catch (e) {
    // Running in separate process, will use file-based communication
    debugLog('Not in Electron main process, using direct file operations');
}

// Utility functions
function debugLog(message, data = null) {
  if (DEBUG_MODE) {
    const timestamp = new Date().toISOString();
    console.error(`[DEBUG ${timestamp}] ${message}`);
    if (data) console.error(JSON.stringify(data, null, 2));
  }
}

function normalizeId(agentId) {
  return agentId ? agentId.toLowerCase() : agentId;
}

function generateBlockId() {
  return 'block_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Agent configuration helpers
async function getAgentConfigPath(agentId) {
  const id = normalizeId(agentId);
  // Support both formats: with or without directory structure
  let configPath = path.join(AGENT_DIR, id, 'config.json');
  
  // Check if file exists in directory structure
  if (await fs.access(configPath).then(() => true).catch(() => false)) {
    return configPath;
  }
  
  // Fallback to flat file structure
  configPath = path.join(AGENT_DIR, `${id}.json`);
  return configPath;
}

async function loadAgentConfig(agentId) {
  const id = normalizeId(agentId);
  try {
    const configPath = await getAgentConfigPath(id);
    
    if (!await fs.access(configPath).then(() => true).catch(() => false)) {
      throw new Error(`Agent configuration not found: ${id}`);
    }
    
    let lastError = null;
    for (let i = 0; i < 3; i++) {
        try {
            const configData = await fs.readFile(configPath, 'utf-8');
            if (!configData.trim()) throw new Error('Empty config file');
            return JSON.parse(configData);
        } catch (e) {
            lastError = e;
            await new Promise(r => setTimeout(r, 100 * (i + 1)));
        }
    }
    throw lastError;
  } catch (error) {
    debugLog('Error loading agent config', { id, error: error.message });
    throw error;
  }
}

async function saveAgentConfig(agentId, config) {
  const id = normalizeId(agentId);
  const configPath = await getAgentConfigPath(id);
  const lockFile = configPath + '.lock';
  const tempFile = configPath + '.tmp';
  const startTime = Date.now();
  const timeout = 5000;

  try {
    // Acquire Lock
    let locked = false;
    while (!locked && (Date.now() - startTime < timeout)) {
        try {
            await fs.writeFile(lockFile, `${process.pid}-${Date.now()}`, { flag: 'wx' });
            locked = true;
        } catch (e) {
            if (e.code === 'EEXIST') {
                await new Promise(r => setTimeout(r, 100));
            } else {
                throw e;
            }
        }
    }

    if (!locked) {
        // Fallback: try to remove stale lock
        await fs.unlink(lockFile).catch(() => {});
        await fs.writeFile(lockFile, `${process.pid}-${Date.now()}`, { flag: 'wx' });
    }

    // Atomic write
    await fs.writeFile(tempFile, JSON.stringify(config, null, 2), 'utf-8');
    
    // Create backup if possible
    if (await fs.access(configPath).then(() => true).catch(() => false)) {
        await fs.copyFile(configPath, configPath + '.backup').catch(() => {});
    }

    // Atomically move
    await fs.rename(tempFile, configPath);
    
    debugLog('Agent config saved atomically', { id, configPath });
  } catch (error) {
    debugLog('Error saving agent config', { id, error: error.message });
    throw error;
  } finally {
    await fs.unlink(lockFile).catch(() => {});
    await fs.unlink(tempFile).catch(() => {});
  }
}

// Command handlers
async function getPromptMode(agentId) {
  try {
    const config = await loadAgentConfig(agentId);
    const mode = config.promptMode || 'original';
    
    return {
      success: true,
      data: {
        agentId,
        mode,
        availableModes: ['original', 'modular', 'preset'],
        message: `当前提示词模式: ${mode}`
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function setPromptMode(agentId, mode) {
    try {
        if (!['original', 'modular', 'preset'].includes(mode)) {
            throw new Error(`Invalid mode: ${mode}. Must be 'original', 'modular', or 'preset'`);
        }
        
        const config = await loadAgentConfig(agentId);
        config.promptMode = mode;
        
        // Update systemPrompt field for immediate effect
        let systemPrompt = '';
        switch (mode) {
            case 'original':
                systemPrompt = config.originalSystemPrompt || config.systemPrompt || '';
                break;
            case 'modular':
                if (config.advancedSystemPrompt && typeof config.advancedSystemPrompt === 'object') {
                    const blocks = config.advancedSystemPrompt.blocks || [];
                    systemPrompt = blocks
                        .filter(block => !block.disabled)
                        .map(block => {
                            if (block.type === 'newline') {
                                return '\n';
                            } else {
                                let content = block.content || '';
                                if (block.variants && block.variants.length > 0) {
                                    const selectedIndex = block.selectedVariant || 0;
                                    content = block.variants[selectedIndex] || content;
                                }
                                return content;
                            }
                        })
                        .join('');
                }
                break;
            case 'preset':
                systemPrompt = config.presetSystemPrompt || '';
                break;
        }
        
        config.systemPrompt = systemPrompt;
        await saveAgentConfig(agentId, config);
        
        debugLog('Mode switched and systemPrompt updated', { agentId, mode, promptLength: systemPrompt.length });
        
        return {
            success: true,
            data: {
                message: `提示词模式已切换到: ${mode}，systemPrompt 已同步更新`,
                mode,
                systemPrompt
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

async function getActivePrompt(agentId) {
  try {
    const config = await loadAgentConfig(agentId);
    const mode = config.promptMode || 'original';
    let systemPrompt = '';
    
    switch (mode) {
      case 'original':
        systemPrompt = config.originalSystemPrompt || config.systemPrompt || '';
        break;
      
      case 'modular':
        if (config.advancedSystemPrompt && typeof config.advancedSystemPrompt === 'object') {
          const blocks = config.advancedSystemPrompt.blocks || [];
          systemPrompt = blocks
            .filter(block => !block.disabled)
            .map(block => {
              if (block.type === 'newline') {
                return '\n';
              } else {
                let content = block.content || '';
                if (block.variants && block.variants.length > 0) {
                  const selectedIndex = block.selectedVariant || 0;
                  content = block.variants[selectedIndex] || content;
                }
                return content;
              }
            })
            .join('');
        }
        break;
      
      case 'preset':
        systemPrompt = config.presetSystemPrompt || '';
        break;
    }
    
    return {
      success: true,
      data: {
        agentId,
        mode,
        systemPrompt,
        length: systemPrompt.length
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function setOriginalPrompt(agentId, content) {
  try {
    const config = await loadAgentConfig(agentId);
    config.originalSystemPrompt = content;
    await saveAgentConfig(agentId, config);
    
    return {
      success: true,
      data: {
        message: '原始提示词已更新',
        length: content.length
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function getModularBlocks(agentId) {
  try {
    const config = await loadAgentConfig(agentId);
    
    if (!config.advancedSystemPrompt || typeof config.advancedSystemPrompt !== 'object') {
      config.advancedSystemPrompt = {
        blocks: [],
        hiddenBlocks: { default: [] },
        warehouseOrder: ['default']
      };
    }
    
    const blocks = config.advancedSystemPrompt.blocks || [];
    
    return {
      success: true,
      data: {
        blocks,
        totalBlocks: blocks.length,
        enabledBlocks: blocks.filter(b => !b.disabled).length
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function addBlock(agentId, type, content = '', name = '', position = null) {
  try {
    const config = await loadAgentConfig(agentId);
    
    if (!config.advancedSystemPrompt || typeof config.advancedSystemPrompt !== 'object') {
      config.advancedSystemPrompt = {
        blocks: [],
        hiddenBlocks: { default: [] },
        warehouseOrder: ['default']
      };
    }
    
    const newBlock = {
      id: generateBlockId(),
      type,
      content,
      name,
      disabled: false
    };
    
    if (type === 'text' && content) {
      newBlock.variants = [content];
      newBlock.selectedVariant = 0;
    }
    
    if (position !== null && position >= 0 && position <= config.advancedSystemPrompt.blocks.length) {
      config.advancedSystemPrompt.blocks.splice(position, 0, newBlock);
    } else {
      config.advancedSystemPrompt.blocks.push(newBlock);
    }
    
    await saveAgentConfig(agentId, config);
    
    return {
      success: true,
      data: {
        message: '积木块已添加',
        block: newBlock,
        totalBlocks: config.advancedSystemPrompt.blocks.length
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function updateBlock(agentId, blockId, updates) {
  try {
    const config = await loadAgentConfig(agentId);
    
    if (!config.advancedSystemPrompt?.blocks) {
      throw new Error('No modular blocks found');
    }
    
    const blockIndex = config.advancedSystemPrompt.blocks.findIndex(b => b.id === blockId);
    if (blockIndex === -1) {
      throw new Error(`Block not found: ${blockId}`);
    }
    
    const block = config.advancedSystemPrompt.blocks[blockIndex];
    
    if (updates.content !== undefined) {
      block.content = updates.content;
      // Update the current variant if exists
      if (block.variants && block.variants.length > 0) {
        const selectedIndex = block.selectedVariant || 0;
        block.variants[selectedIndex] = updates.content;
      }
    }
    
    if (updates.name !== undefined) {
      block.name = updates.name;
    }
    
    if (updates.disabled !== undefined) {
      block.disabled = updates.disabled;
    }
    
    await saveAgentConfig(agentId, config);
    
    return {
      success: true,
      data: {
        message: '积木块已更新',
        block
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function deleteBlock(agentId, blockId) {
  try {
    const config = await loadAgentConfig(agentId);
    
    if (!config.advancedSystemPrompt?.blocks) {
      throw new Error('No modular blocks found');
    }
    
    const blockIndex = config.advancedSystemPrompt.blocks.findIndex(b => b.id === blockId);
    if (blockIndex === -1) {
      throw new Error(`Block not found: ${blockId}`);
    }
    
    const deletedBlock = config.advancedSystemPrompt.blocks.splice(blockIndex, 1)[0];
    await saveAgentConfig(agentId, config);
    
    return {
      success: true,
      data: {
        message: '积木块已删除',
        deletedBlock,
        remainingBlocks: config.advancedSystemPrompt.blocks.length
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function moveBlock(agentId, blockId, newPosition) {
  try {
    const config = await loadAgentConfig(agentId);
    
    if (!config.advancedSystemPrompt?.blocks) {
      throw new Error('No modular blocks found');
    }
    
    const blocks = config.advancedSystemPrompt.blocks;
    const blockIndex = blocks.findIndex(b => b.id === blockId);
    
    if (blockIndex === -1) {
      throw new Error(`Block not found: ${blockId}`);
    }
    
    if (newPosition < 0 || newPosition >= blocks.length) {
      throw new Error(`Invalid position: ${newPosition}`);
    }
    
    const [movedBlock] = blocks.splice(blockIndex, 1);
    blocks.splice(newPosition, 0, movedBlock);
    
    await saveAgentConfig(agentId, config);
    
    return {
      success: true,
      data: {
        message: `积木块已移动到位置 ${newPosition}`,
        block: movedBlock,
        newPosition
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function addVariant(agentId, blockId, content) {
  try {
    const config = await loadAgentConfig(agentId);
    
    if (!config.advancedSystemPrompt?.blocks) {
      throw new Error('No modular blocks found');
    }
    
    const block = config.advancedSystemPrompt.blocks.find(b => b.id === blockId);
    if (!block) {
      throw new Error(`Block not found: ${blockId}`);
    }
    
    if (block.type === 'newline') {
      throw new Error('Cannot add variants to newline blocks');
    }
    
    if (!block.variants) {
      block.variants = [block.content || ''];
      block.selectedVariant = 0;
    }
    
    block.variants.push(content);
    
    await saveAgentConfig(agentId, config);
    
    return {
      success: true,
      data: {
        message: '内容条目已添加',
        variantIndex: block.variants.length - 1,
        totalVariants: block.variants.length
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function updateVariant(agentId, blockId, variantIndex, content) {
  try {
    const config = await loadAgentConfig(agentId);
    
    if (!config.advancedSystemPrompt?.blocks) {
      throw new Error('No modular blocks found');
    }
    
    const block = config.advancedSystemPrompt.blocks.find(b => b.id === blockId);
    if (!block) {
      throw new Error(`Block not found: ${blockId}`);
    }
    
    if (!block.variants || variantIndex < 0 || variantIndex >= block.variants.length) {
      throw new Error(`Invalid variant index: ${variantIndex}`);
    }
    
    block.variants[variantIndex] = content;
    
    // Update main content if this is the selected variant
    if (block.selectedVariant === variantIndex) {
      block.content = content;
    }
    
    await saveAgentConfig(agentId, config);
    
    return {
      success: true,
      data: {
        message: '内容条目已更新',
        variantIndex
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function deleteVariant(agentId, blockId, variantIndex) {
  try {
    const config = await loadAgentConfig(agentId);
    
    if (!config.advancedSystemPrompt?.blocks) {
      throw new Error('No modular blocks found');
    }
    
    const block = config.advancedSystemPrompt.blocks.find(b => b.id === blockId);
    if (!block) {
      throw new Error(`Block not found: ${blockId}`);
    }
    
    if (!block.variants || block.variants.length <= 1) {
      throw new Error('Cannot delete the last variant. At least one variant must remain.');
    }
    
    if (variantIndex < 0 || variantIndex >= block.variants.length) {
      throw new Error(`Invalid variant index: ${variantIndex}`);
    }
    
    block.variants.splice(variantIndex, 1);
    
    // Adjust selected variant if needed
    if (block.selectedVariant >= block.variants.length) {
      block.selectedVariant = block.variants.length - 1;
    }
    
    block.content = block.variants[block.selectedVariant];
    
    await saveAgentConfig(agentId, config);
    
    return {
      success: true,
      data: {
        message: '内容条目已删除',
        remainingVariants: block.variants.length
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function selectVariant(agentId, blockId, variantIndex) {
  try {
    const config = await loadAgentConfig(agentId);
    
    if (!config.advancedSystemPrompt?.blocks) {
      throw new Error('No modular blocks found');
    }
    
    const block = config.advancedSystemPrompt.blocks.find(b => b.id === blockId);
    if (!block) {
      throw new Error(`Block not found: ${blockId}`);
    }
    
    if (!block.variants || variantIndex < 0 || variantIndex >= block.variants.length) {
      throw new Error(`Invalid variant index: ${variantIndex}`);
    }
    
    block.selectedVariant = variantIndex;
    block.content = block.variants[variantIndex];
    
    await saveAgentConfig(agentId, config);
    
    return {
      success: true,
      data: {
        message: `已选择内容条目 ${variantIndex}`,
        selectedVariant: variantIndex,
        content: block.content
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function hideBlock(agentId, blockId, warehouse = 'default') {
  try {
    const config = await loadAgentConfig(agentId);
    
    if (!config.advancedSystemPrompt?.blocks) {
      throw new Error('No modular blocks found');
    }
    
    const blockIndex = config.advancedSystemPrompt.blocks.findIndex(b => b.id === blockId);
    if (blockIndex === -1) {
      throw new Error(`Block not found: ${blockId}`);
    }
    
    if (!config.advancedSystemPrompt.hiddenBlocks) {
      config.advancedSystemPrompt.hiddenBlocks = { default: [] };
    }
    
    if (!config.advancedSystemPrompt.hiddenBlocks[warehouse]) {
      config.advancedSystemPrompt.hiddenBlocks[warehouse] = [];
    }
    
    const [hiddenBlock] = config.advancedSystemPrompt.blocks.splice(blockIndex, 1);
    config.advancedSystemPrompt.hiddenBlocks[warehouse].push(hiddenBlock);
    
    await saveAgentConfig(agentId, config);
    
    return {
      success: true,
      data: {
        message: `积木块已隐藏到仓库: ${warehouse}`,
        block: hiddenBlock,
        warehouse
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function restoreBlock(agentId, warehouse, blockIndex, position = null) {
  try {
    const config = await loadAgentConfig(agentId);
    
    if (!config.advancedSystemPrompt?.hiddenBlocks?.[warehouse]) {
      throw new Error(`Warehouse not found: ${warehouse}`);
    }
    
    const hiddenBlocks = config.advancedSystemPrompt.hiddenBlocks[warehouse];
    
    if (blockIndex < 0 || blockIndex >= hiddenBlocks.length) {
      throw new Error(`Invalid block index: ${blockIndex}`);
    }
    
    const [restoredBlock] = hiddenBlocks.splice(blockIndex, 1);
    
    // Generate new ID to avoid conflicts
    restoredBlock.id = generateBlockId();
    
    if (position !== null && position >= 0 && position <= config.advancedSystemPrompt.blocks.length) {
      config.advancedSystemPrompt.blocks.splice(position, 0, restoredBlock);
    } else {
      config.advancedSystemPrompt.blocks.push(restoredBlock);
    }
    
    await saveAgentConfig(agentId, config);
    
    return {
      success: true,
      data: {
        message: `积木块已从仓库 ${warehouse} 恢复`,
        block: restoredBlock
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function getWarehouses(agentId) {
  try {
    const config = await loadAgentConfig(agentId);
    
    if (!config.advancedSystemPrompt) {
      config.advancedSystemPrompt = {
        blocks: [],
        hiddenBlocks: { default: [] },
        warehouseOrder: ['default']
      };
    }
    
    const hiddenBlocks = config.advancedSystemPrompt.hiddenBlocks || { default: [] };
    const warehouseOrder = config.advancedSystemPrompt.warehouseOrder || ['default'];
    
    const warehouses = {};
    for (const name of warehouseOrder) {
      warehouses[name] = {
        name,
        blocks: hiddenBlocks[name] || [],
        blockCount: (hiddenBlocks[name] || []).length
      };
    }
    
    return {
      success: true,
      data: {
        warehouses,
        warehouseOrder,
        totalWarehouses: warehouseOrder.length
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function createWarehouse(agentId, warehouseName) {
  try {
    if (warehouseName === 'default') {
      throw new Error('Cannot create warehouse named "default"');
    }
    
    const config = await loadAgentConfig(agentId);
    
    if (!config.advancedSystemPrompt) {
      config.advancedSystemPrompt = {
        blocks: [],
        hiddenBlocks: { default: [] },
        warehouseOrder: ['default']
      };
    }
    
    if (config.advancedSystemPrompt.hiddenBlocks[warehouseName]) {
      throw new Error(`Warehouse already exists: ${warehouseName}`);
    }
    
    config.advancedSystemPrompt.hiddenBlocks[warehouseName] = 
[];
    config.advancedSystemPrompt.warehouseOrder.push(warehouseName);
    
    await saveAgentConfig(agentId, config);
    
    return {
      success: true,
      data: {
        message: `仓库已创建: ${warehouseName}`,
        warehouseName
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function renameWarehouse(agentId, oldName, newName) {
  try {
    if (oldName === 'default') {
      throw new Error('Cannot rename the default warehouse');
    }
    
    if (newName === 'default') {
      throw new Error('Cannot rename to "default"');
    }
    
    const config = await loadAgentConfig(agentId);
    
    if (!config.advancedSystemPrompt?.hiddenBlocks?.[oldName]) {
      throw new Error(`Warehouse not found: ${oldName}`);
    }
    
    if (config.advancedSystemPrompt.hiddenBlocks[newName]) {
      throw new Error(`Warehouse already exists: ${newName}`);
    }
    
    config.advancedSystemPrompt.hiddenBlocks[newName] = config.advancedSystemPrompt.hiddenBlocks[oldName];
    delete config.advancedSystemPrompt.hiddenBlocks[oldName];
    
    const orderIndex = config.advancedSystemPrompt.warehouseOrder.indexOf(oldName);
    if (orderIndex !== -1) {
      config.advancedSystemPrompt.warehouseOrder[orderIndex] = newName;
    }
    
    await saveAgentConfig(agentId, config);
    
    return {
      success: true,
      data: {
        message: `仓库已重命名: ${oldName} -> ${newName}`,
        oldName,
        newName
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function deleteWarehouse(agentId, warehouseName) {
  try {
    if (warehouseName === 'default') {
      throw new Error('Cannot delete the default warehouse');
    }
    
    const config = await loadAgentConfig(agentId);
    
    if (!config.advancedSystemPrompt?.hiddenBlocks?.[warehouseName]) {
      throw new Error(`Warehouse not found: ${warehouseName}`);
    }
    
    const blockCount = config.advancedSystemPrompt.hiddenBlocks[warehouseName].length;
    delete config.advancedSystemPrompt.hiddenBlocks[warehouseName];
    
    config.advancedSystemPrompt.warehouseOrder = config.advancedSystemPrompt.warehouseOrder.filter(
      w => w !== warehouseName
    );
    
    await saveAgentConfig(agentId, config);
    
    return {
      success: true,
      data: {
        message: `仓库已删除: ${warehouseName}（包含 ${blockCount} 个积木块）`,
        warehouseName,
        deletedBlockCount: blockCount
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function listPresets(agentId) {
  try {
    const config = await loadAgentConfig(agentId);
    const presetPath = config.presetPromptPath || './AppData/systemPromptPresets';
    
    // Resolve path
    let absolutePath = presetPath;
    if (!path.isAbsolute(presetPath)) {
      const cleanPath = presetPath.replace(/^\.[\/\\]/, '');
      if (cleanPath.startsWith('AppData')) {
        const appDataRoot = path.join(__dirname, '..', '..', '..', 'AppData');
        absolutePath = path.join(appDataRoot, cleanPath.substring('AppData'.length).replace(/^[\/\\]/, ''));
      } else {
        const projectRoot = path.join(__dirname, '..', '..', '..');
        absolutePath = path.join(projectRoot, cleanPath);
      }
    }
    
    absolutePath = path.resolve(absolutePath);
    
    // Check if directory exists
    if (!await fs.access(absolutePath).then(() => true).catch(() => false)) {
      return {
        success: true,
        data: {
          presets: [],
          presetPath: absolutePath,
          message: '预设目录不存在或为空'
        }
      };
    }
    
    // Read directory
    const files = await fs.readdir(absolutePath);
    const presets = [];
    
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (ext === '.md' || ext === '.txt') {
        const filePath = path.join(absolutePath, file);
        const stats = await fs.stat(filePath);
        
        if (stats.isFile()) {
          presets.push({
            name: path.basename(file, ext),
            path: filePath,
            extension: ext,
            size: stats.size,
            modified: stats.mtime.toISOString()
          });
        }
      }
    }
    
    presets.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    
    return {
      success: true,
      data: {
        presets,
        presetPath: absolutePath,
        totalPresets: presets.length
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function setPreset(agentId, presetPath) {
  try {
    // Read preset content
    if (!await fs.access(presetPath).then(() => true).catch(() => false)) {
      throw new Error(`Preset file not found: ${presetPath}`);
    }
    
    const content = await fs.readFile(presetPath, 'utf-8');
    
    const config = await loadAgentConfig(agentId);
    config.presetSystemPrompt = content;
    config.selectedPreset = presetPath;
    
    await saveAgentConfig(agentId, config);
    
    return {
      success: true,
      data: {
        message: `预设已应用: ${path.basename(presetPath)}`,
        presetPath,
        contentLength: content.length
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function setPresetContent(agentId, content) {
  try {
    const config = await loadAgentConfig(agentId);
    config.presetSystemPrompt = content;
    config.selectedPreset = ''; // Clear selected preset when setting custom content
    
    await saveAgentConfig(agentId, config);
    
    return {
      success: true,
      data: {
        message: '预设内容已更新',
        contentLength: content.length
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// Main execution function
async function processRequest(request) {
  const { command, ...parameters } = request;
  
  debugLog('Processing request', { command, parameters });
  
  try {
    switch (command) {
      case 'GetPromptMode':
        return await getPromptMode(parameters.agentId);
      
      case 'SetPromptMode':
        return await setPromptMode(parameters.agentId, parameters.mode);
      
      case 'GetActivePrompt':
        return await getActivePrompt(parameters.agentId);
      
      case 'SetOriginalPrompt':
        return await setOriginalPrompt(parameters.agentId, parameters.content);
      
      case 'GetModularBlocks':
        return await getModularBlocks(parameters.agentId);
      
      case 'AddBlock':
        return await addBlock(
          parameters.agentId,
          parameters.type,
          parameters.content,
          parameters.name,
          parameters.position !== undefined ? parseInt(parameters.position) : null
        );
      
      case 'UpdateBlock':
        return await updateBlock(parameters.agentId, parameters.blockId, {
          content: parameters.content,
          name: parameters.name,
          disabled: parameters.disabled !== undefined ? parameters.disabled === 'true' || parameters.disabled === true : undefined
        });
      
      case 'DeleteBlock':
        return await deleteBlock(parameters.agentId, parameters.blockId);
      
      case 'MoveBlock':
        return await moveBlock(parameters.agentId, parameters.blockId, parseInt(parameters.newPosition));
      
      case 'AddVariant':
        return await addVariant(parameters.agentId, parameters.blockId, parameters.content);
      
      case 'UpdateVariant':
        return await updateVariant(
          parameters.agentId,
          parameters.blockId,
          parseInt(parameters.variantIndex),
          parameters.content
        );
      
      case 'DeleteVariant':
        return await deleteVariant(
          parameters.agentId,
          parameters.blockId,
          parseInt(parameters.variantIndex)
        );
      
      case 'SelectVariant':
        return await selectVariant(
          parameters.agentId,
          parameters.blockId,
          parseInt(parameters.variantIndex)
        );
      
      case 'HideBlock':
        return await hideBlock(parameters.agentId, parameters.blockId, parameters.warehouse);
      
      case 'RestoreBlock':
        return await restoreBlock(
          parameters.agentId,
          parameters.warehouse,
          parseInt(parameters.blockIndex),
          parameters.position !== undefined ? parseInt(parameters.position) : null
        );
      
      case 'GetWarehouses':
        return await getWarehouses(parameters.agentId);
      
      case 'CreateWarehouse':
        return await createWarehouse(parameters.agentId, parameters.warehouseName);
      
      case 'RenameWarehouse':
        return await renameWarehouse(parameters.agentId, parameters.oldName, parameters.newName);
      
      case 'DeleteWarehouse':
        return await deleteWarehouse(parameters.agentId, parameters.warehouseName);
      
      case 'ListPresets':
        return await listPresets(parameters.agentId);
      
      case 'SetPreset':
        return await setPreset(parameters.agentId, parameters.presetPath);
      
      case 'SetPresetContent':
        return await setPresetContent(parameters.agentId, parameters.content);
      
      default:
        return {
          success: false,
          error: `Unknown command: ${command}`
        };
    }
  } catch (error) {
    debugLog('Error processing request', { command, error: error.message });
    return {
      success: false,
      error: `Failed to process command: ${error.message}`
    };
  }
}

// Setup stdio communication
process.stdin.setEncoding('utf8');
process.stdin.on('data', async data => {
  try {
    const lines = data.toString().trim().split('\n');
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      const request = JSON.parse(line);
      const response = await processRequest(request);
      
      // Convert to VCP protocol format
      const vcpResponse = convertToVCPFormat(response);
      console.log(JSON.stringify(vcpResponse));
    }
  } catch (error) {
    const errorResponse = {
      status: 'error',
      error: `Invalid request format: ${error.message}`
    };
    console.log(JSON.stringify(errorResponse));
  }
});

// Convert internal response format to VCP protocol format
function convertToVCPFormat(response) {
  if (response.success) {
    return {
      status: 'success',
      result: response.data || { message: response.message || 'Operation completed successfully' }
    };
  } else {
    return {
      status: 'error',
      error: response.error || 'Unknown error occurred'
    };
  }
}

// Handle process termination
process.on('SIGTERM', () => {
  debugLog('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  debugLog('Received SIGINT, shutting down gracefully');
  process.exit(0);
});

debugLog('PromptSponsor plugin started and listening for requests');