/**
 * 同步场景下的默认值定义
 * 新增字段：只需在此文件添加，无需改动其他模块
 */

// Agent 配置默认值 (对齐 VChat 创建新 Agent 的标准)
const AGENT_DEFAULTS = {
  name: "Unnamed Agent",
  systemPrompt: "", // 由 createAgentConfig 动态生成
  model: "gemini-2.5-flash",
  temperature: 1.0,
  contextTokenLimit: 1000000,
  maxOutputTokens: 64000,
  streamOutput: true,
};

// Group 配置默认值 (对齐 VChat 创建新 Group 的标准)
const GROUP_DEFAULTS = {
  name: "Unnamed Group",
  mode: "sequential",
  members: [],
  memberTags: {},
  groupPrompt: "",
  invitePrompt:
    "现在轮到你{{VCPChatAgentName}}发言了。系统已经为大家添加[xxx的发言：]这样的标记头，以用于区分不同发言来自谁。大家不用自己再输出自己的发言标记头，也不需要讨论发言标记系统，正常聊天即可。",
  useUnifiedModel: false,
  unifiedModel: "",
  tagMatchMode: "strict",
  avatar: null,
  avatarCalculatedColor: null,
};

// Agent Topic 默认值 (仅当手机端缺失 locked/unread 时使用)
// 实际场景：手机端 TopicSyncDTO 已包含这些字段，会覆盖默认值
const AGENT_TOPIC_DEFAULTS = {
  locked: true,
  unread: false,
  creatorSource: "ui", // 桌面端特有字段
};

// Group Topic 无额外默认值 (只有基础字段)
// Group Topic 在桌面端不存储 locked/unread，上传时忽略，下载时注入固定值

/**
 * 创建新建 Agent 时的完整配置
 * @param {string} id - Agent ID (仅用于目录名，不写入配置)
 * @param {object} dto - 同步 DTO (手机端 AgentSyncDTO 不含 topics 字段)
 * @returns {object} 完整配置
 */
function createAgentConfig(id, dto) {
  const name = dto.name || AGENT_DEFAULTS.name;
  return {
    // 注意：Agent 配置不写入 id 字段，id 由目录名推导
    name,
    systemPrompt: dto.systemPrompt || `你是 ${name}。`,
    model: dto.model ?? AGENT_DEFAULTS.model,
    temperature: dto.temperature ?? AGENT_DEFAULTS.temperature,
    contextTokenLimit: dto.contextTokenLimit ?? AGENT_DEFAULTS.contextTokenLimit,
    maxOutputTokens: dto.maxOutputTokens ?? AGENT_DEFAULTS.maxOutputTokens,
    streamOutput: dto.streamOutput ?? AGENT_DEFAULTS.streamOutput,
    topics: [],
    disableCustomColors: true,
    useThemeColorsInChat: true,
  };
}

/**
 * 创建新建 Group 时的完整配置
 * @param {string} id - Group ID
 * @param {object} dto - 同步 DTO
 * @returns {object} 完整配置
 */
function createGroupConfig(id, dto) {
  return {
    id,
    name: dto.name || GROUP_DEFAULTS.name,
    avatar: GROUP_DEFAULTS.avatar,
    avatarCalculatedColor: GROUP_DEFAULTS.avatarCalculatedColor,
    members: dto.members ?? GROUP_DEFAULTS.members,
    mode: dto.mode ?? GROUP_DEFAULTS.mode,
    tagMatchMode: dto.tagMatchMode ?? GROUP_DEFAULTS.tagMatchMode,
    memberTags: dto.memberTags ?? GROUP_DEFAULTS.memberTags,
    groupPrompt: dto.groupPrompt ?? GROUP_DEFAULTS.groupPrompt,
    invitePrompt: dto.invitePrompt ?? GROUP_DEFAULTS.invitePrompt,
    useUnifiedModel: dto.useUnifiedModel ?? GROUP_DEFAULTS.useUnifiedModel,
    unifiedModel: dto.unifiedModel ?? GROUP_DEFAULTS.unifiedModel,
    createdAt: dto.createdAt || Date.now(),
    topics: [],
  };
}

/**
 * 创建新建 Agent Topic 时的完整配置
 * @param {object} dto - 同步 DTO
 * @returns {object} 完整 topic 配置
 */
function createAgentTopic(dto) {
  return {
    id: dto.id,
    name: dto.name,
    createdAt: dto.createdAt,
    locked: dto.locked ?? AGENT_TOPIC_DEFAULTS.locked,
    unread: dto.unread ?? AGENT_TOPIC_DEFAULTS.unread,
    creatorSource: AGENT_TOPIC_DEFAULTS.creatorSource,
  };
}

/**
 * 创建新建 Group Topic 时的完整配置
 * @param {object} dto - 同步 DTO
 * @returns {object} 完整 topic 配置
 */
function createGroupTopic(dto) {
  return {
    id: dto.id,
    name: dto.name,
    createdAt: dto.createdAt,
  };
}

/**
 * 构造桌面端标准的附件对象
 * @param {object} dto - 手机端传来的附件 DTO
 * @param {string} desktopPath - 桌面端物理路径 (为空则根据hash推导)
 * @param {string} ext - 扩展名
 * @returns {object} 桌面端标准附件结构
 */
function createDesktopAttachment(dto, desktopPath, ext) {
  const hash = dto.hash || "";
  const name = dto.name || "unnamed";
  const type = dto.type || "application/octet-stream";
  const size = dto.size || 0;
  const createdAt = dto.createdAt || Date.now();
  
  // 推导合理的内部名和展示路径 (修正：统一使用 file:// 前缀)
  const internalFileName = hash ? `${hash}${ext}` : "";
  const desktopSrc = desktopPath 
    ? `file://${desktopPath}` 
    : (hash ? `file://G:\\VCPChat\\AppData\\UserData\\attachments\\${internalFileName}` : "");

  return {
    type,
    src: desktopSrc,
    name,
    size,
    status: dto.status || "ready",
    _fileManagerData: {
      id: `attachment_${hash}`,
      name,
      internalFileName,
      internalPath: desktopSrc,
      type,
      size,
      hash,
      createdAt,
      extractedText: dto.extractedText || null,
      imageFrames: dto.imageFrames || null,
    }
  };
}

module.exports = {
  AGENT_DEFAULTS,
  GROUP_DEFAULTS,
  AGENT_TOPIC_DEFAULTS,
  createAgentConfig,
  createGroupConfig,
  createAgentTopic,
  createGroupTopic,
  createDesktopAttachment,
};
