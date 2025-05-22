// Chat Auto Backup 插件 - 自动保存和恢复最近三次聊天记录
// 主要功能：
// 1. 自动保存最近聊天记录到IndexedDB (基于事件触发, 区分立即与防抖)
// 2. 在插件页面显示保存的记录
// 3. 提供恢复功能，将保存的聊天记录恢复到新的聊天中
// 4. 使用Web Worker优化深拷贝性能
// 5. 对于高频事件强制保存，getcontext轮询确保数据一致性

import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings,
} from '../../../extensions.js';

import {
    // --- 核心应用函数 ---
    saveSettingsDebounced,
    eventSource,
    event_types,
    selectCharacterById,    // 用于选择角色
    doNewChat,              // 用于创建新聊天
    printMessages,          // 用于刷新聊天UI
    scrollChatToBottom,     // 用于滚动到底部
    updateChatMetadata,     // 用于更新聊天元数据
    saveChatConditional,    // 用于保存聊天
    saveChat,               // 用于插件强制保存聊天
    characters,             // 需要访问角色列表来查找索引
    getThumbnailUrl,        // 可能需要获取头像URL
    getRequestHeaders,      // 用于API请求的头部
    openCharacterChat,      // 用于打开角色聊天
} from '../../../../script.js';

import {
    // --- 群组相关函数 ---
    select_group_chats,     // 用于选择群组聊天
} from '../../../group-chats.js';

import { POPUP_TYPE, 
Popup,
} from '../../../popup.js';

// --- 备份类型枚举 ---
const BACKUP_TYPE = {
    STANDARD: 'standard', // 用于 AI 回复, 用户发送, 新swipe生成
    SWIPE: 'swipe'        // 用于在已存在的swipes之间切换
};

// --- 备份状态控制 ---
let isBackupInProgress = false; // 并发控制标志
let backupTimeout = null;       // 防抖定时器 ID
let currentBackupAttemptId = null; // 存储最新一次备份尝试的唯一ID

// --- 表格UI监听相关 ---
let metadataHashOnDrawerOpen = null; // 抽屉打开时的元数据哈希值
let tableDrawerElement = null; // 添加全局变量声明，用于保存抽屉元素引用

// 在文件顶部添加一个新的标志变量
let messageSentRecently = false;
let messageSentResetTimer = null;

// 优化的高效哈希函数 - 专为比较优化，非加密用途
function fastHash(str) {
    if (!str) return "0";
    
    // 使用FNV-1a算法 - 快速且碰撞率低，适合比较目的
    const FNV_PRIME = 0x01000193;
    const FNV_OFFSET_BASIS = 0x811c9dc5;
    
    let hash = FNV_OFFSET_BASIS;
    
    // 处理完整字符串，无需采样或截断
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * FNV_PRIME) & 0xffffffff; // 保持32位精度
    }
    
    return (hash >>> 0).toString(16); // 转为无符号值并返回16进制表示
}

// 替换原来的simpleHash函数
async function simpleHash(str) {
    if (!str) return null;
    
    // 直接使用同步哈希，无需异步
    return fastHash(str);
}

// 表格抽屉观察器回调函数
const drawerObserverCallback = async function(mutationsList, observer) {
    for(const mutation of mutationsList) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
            const tableDrawerContent = mutation.target;
            const currentDisplayState = window.getComputedStyle(tableDrawerContent).display;

            // --- 抽屉打开逻辑 ---
            if (currentDisplayState !== 'none' && metadataHashOnDrawerOpen === null) {
                logDebug('[聊天自动备份] 表格抽屉已打开。获取初始 chatMetadata 哈希...');
                const context = getContext();
                if (context && context.chatMetadata) {
                    try {
                        // 处理完整元数据
                        const metadataString = JSON.stringify(context.chatMetadata);
                        // 使用同步哈希函数无需await
                        metadataHashOnDrawerOpen = fastHash(metadataString);
                        logDebug(`[聊天自动备份] 抽屉打开时 chatMetadata 哈希: ${metadataHashOnDrawerOpen}`);
                    } catch (e) {
                        console.error('[聊天自动备份] 计算抽屉打开时元数据哈希失败:', e);
                        metadataHashOnDrawerOpen = 'error_on_open';
                    }
                } else {
                    logDebug('[聊天自动备份] 抽屉打开时 chatMetadata 不存在，将强制备份');
                    metadataHashOnDrawerOpen = null; // 确保关闭时会因 previousHash 为 null 而备份
                }
            }
            // --- 抽屉关闭逻辑 ---
            else if (currentDisplayState === 'none' && metadataHashOnDrawerOpen !== null && metadataHashOnDrawerOpen !== 'closing_in_progress') {
                logDebug('[聊天自动备份] 表格抽屉已关闭。检查 chatMetadata 是否变化...');
                const previousHash = metadataHashOnDrawerOpen;
                // 立即将标志设置为处理中，防止重复触发
                metadataHashOnDrawerOpen = 'closing_in_progress'; // 防止动画期间重复触发
                
                const context = getContext();
                let currentMetadataHash = null;
                if (context && context.chatMetadata) {
                    try {
                        const metadataString = JSON.stringify(context.chatMetadata);
                        // 使用同步哈希函数
                        currentMetadataHash = fastHash(metadataString);
                        logDebug(`[聊天自动备份] 抽屉关闭时 chatMetadata 哈希: ${currentMetadataHash}`);
                    } catch (e) {
                        console.error('[聊天自动备份] 计算抽屉关闭时元数据哈希失败:', e);
                        currentMetadataHash = 'error_on_close';
                    }
                } else {
                    logDebug('[聊天自动备份] 抽屉关闭时 chatMetadata 不存在');
                }

                // 检查元数据是否变化
                if (previousHash === null || previousHash === 'error_on_open' || 
                    currentMetadataHash === 'error_on_close' || previousHash !== currentMetadataHash) {
                    
                    logDebug(`[聊天自动备份] chatMetadata 发生变化 (打开时: ${previousHash}, 关闭时: ${currentMetadataHash}) 或初始状态未知，准备触发备份。`);
                    
                    // 检查当前是否有正在执行的备份，避免冲突
                    if (!isBackupInProgress) {
                        logDebug('[聊天自动备份] 没有进行中的备份，执行表格元数据变化导致的立即备份');
                        // 使用 false 参数 - 不强制保存，不需要轮询
                        performBackupConditional(BACKUP_TYPE.STANDARD, false).catch(error => {
                            console.error('[聊天自动备份] 表格抽屉关闭事件触发的备份失败:', error);
                        });
                    } else {
                        logDebug('[聊天自动备份] 已有备份进行中，跳过表格元数据变化导致的备份');
                    }
                } else {
                    logDebug('[聊天自动备份] chatMetadata 哈希值一致，不触发备份。');
                }
                
                // 等待一段时间后才重置，防止多次触发关闭处理
                setTimeout(() => {
                    metadataHashOnDrawerOpen = null; // 为下一次打开重置
                    logDebug('[聊天自动备份] 抽屉关闭处理完毕，重置哈希状态');
                }, 500);
            }
        }
    }
};

// --- 新增：用于API交互的辅助函数 ---

/**
 * 获取指定角色聊天文件的完整内容 (元数据 + 消息数组)
 * @param {string} characterName - 角色名称
 * @param {string} chatFileName - 聊天文件名 (不带 .jsonl)
 * @param {string} avatarFileName - 角色头像文件名
 * @returns {Promise<Array|null>} 返回包含元数据和消息的数组，或在失败时返回null
 */
async function fetchCharacterChatContent(characterName, chatFileName, avatarFileName) {
    logDebug(`[API] 正在获取角色 "${characterName}" 的聊天文件 "${chatFileName}.jsonl" 内容...`);
    try {
        const response = await fetch('/api/chats/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                ch_name: characterName,
                file_name: chatFileName,
                avatar_url: avatarFileName,
            }),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`获取角色聊天内容API失败: ${response.status} - ${errorText}`);
        }
        const chatContentArray = await response.json(); // 应该返回 [metadata, ...messages]
        logDebug(`[API] 成功获取角色 "${characterName}" 的聊天文件内容，总条目数: ${chatContentArray.length}`);
        return chatContentArray;
    } catch (error) {
        console.error(`[API] fetchCharacterChatContent 错误:`, error);
        return null;
    }
}

/**
 * 获取指定群组聊天文件的消息内容 (消息数组)
 * 注意：此API通常只返回消息，元数据需从群组对象获取
 * @param {string} groupId - 群组ID
 * @param {string} groupChatId - 群组聊天ID (文件名，不带 .jsonl)
 * @returns {Promise<Array|null>} 返回消息数组，或在失败时返回null
 */
async function fetchGroupChatMessages(groupId, groupChatId) {
    logDebug(`[API] 正在获取群组 "${groupId}" 的聊天 "${groupChatId}.jsonl" 消息内容...`);
    try {
        const response = await fetch('/api/chats/group/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                id: groupId, 
                chat_id: groupChatId
            }),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`获取群组聊天消息API失败: ${response.status} - ${errorText}`);
        }
        const messagesArray = await response.json();
        logDebug(`[API] 成功获取群组 "${groupId}" 的聊天 "${groupChatId}.jsonl" 消息，消息数: ${messagesArray.length}`);
        return messagesArray;
    } catch (error) {
        console.error(`[API] fetchGroupChatMessages 错误:`, error);
        return null;
    }
}

/**
 * 将聊天元数据和消息数组构造成 .jsonl 格式的字符串
 * @param {object} metadata - 聊天元数据对象
 * @param {Array} messages - 聊天消息对象数组
 * @returns {string} .jsonl 格式的字符串
 */
function constructJsonlString(metadata, messages) {
    if (!metadata || !Array.isArray(messages)) {
        console.error('[CONSTRUCT] 无效的元数据或消息数组传入 constructJsonlString');
        return '';
    }
    let jsonlString = JSON.stringify(metadata) + '\n';
    messages.forEach(message => {
        jsonlString += JSON.stringify(message) + '\n';
    });
    return jsonlString;
}

// 扩展名和设置初始化
const PLUGIN_NAME = 'chat-history-backupQ8';
const DEFAULT_SETTINGS = {
    maxEntityCount: 3,        // 最多保存几个不同角色/群组的备份 (新增)
    maxBackupsPerEntity: 3,   // 每个角色/群组最多保存几个备份 (新增)
    backupDebounceDelay: 1500, // 防抖延迟时间 (毫秒)
    debug: true, // 调试模式
};

// IndexedDB 数据库名称和版本
const DB_NAME = 'ST_ChatAutoBackupY3';
const DB_VERSION = 1;
const STORE_NAME = 'backups';

// Web Worker 实例 (稍后初始化)
let backupWorker = null;
// 用于追踪 Worker 请求的 Promise
const workerPromises = {};
let workerRequestId = 0;

// 数据库连接池 - 实现单例模式
let dbConnection = null;

// --- 深拷贝逻辑 (将在Worker和主线程中使用) ---
const deepCopyLogicString = `
    // Worker message handler - 优化版本，分离metadata和messages处理
    self.onmessage = function(e) {
        const { id, payload } = e.data;
        if (!payload) {
             self.postMessage({ id, error: 'Invalid payload received by worker' });
             return;
        }
        try {
            // payload中已经是通过postMessage的结构化克隆获得的API数据副本
            // 无需额外深拷贝，直接返回
            self.postMessage({ id, result: payload });
        } catch (error) {
            console.error('[Worker] Error during data processing for ID:', id, error);
            self.postMessage({ id, error: error.message || 'Worker processing failed' });
        }
    };
`;


// --- 日志函数 ---
function logDebug(...args) {
    const settings = extension_settings[PLUGIN_NAME];
    if (settings && settings.debug) {
        console.log(`[聊天自动备份][${new Date().toLocaleTimeString()}]`, ...args);
    }
}

// --- 设置初始化 ---
function initSettings() {
    console.log('[聊天自动备份] 初始化插件设置');
    if (!extension_settings[PLUGIN_NAME]) {
        console.log('[聊天自动备份] 创建新的插件设置');
        extension_settings[PLUGIN_NAME] = { ...DEFAULT_SETTINGS };
    }

    const settings = extension_settings[PLUGIN_NAME];

    // 确保所有设置存在并有默认值
    settings.maxEntityCount = settings.maxEntityCount ?? DEFAULT_SETTINGS.maxEntityCount;
    settings.maxBackupsPerEntity = settings.maxBackupsPerEntity ?? DEFAULT_SETTINGS.maxBackupsPerEntity;
    settings.backupDebounceDelay = settings.backupDebounceDelay ?? DEFAULT_SETTINGS.backupDebounceDelay;
    settings.debug = settings.debug ?? DEFAULT_SETTINGS.debug;

    // 验证设置合理性
    if (typeof settings.maxEntityCount !== 'number' || settings.maxEntityCount < 1 || settings.maxEntityCount > 10) {
        console.warn(`[聊天自动备份] 无效的最大角色/群组数 ${settings.maxEntityCount}，重置为默认值 ${DEFAULT_SETTINGS.maxEntityCount}`);
        settings.maxEntityCount = DEFAULT_SETTINGS.maxEntityCount;
    }

    if (typeof settings.maxBackupsPerEntity !== 'number' || settings.maxBackupsPerEntity < 1 || settings.maxBackupsPerEntity > 10) {
        console.warn(`[聊天自动备份] 无效的每角色/群组最大备份数 ${settings.maxBackupsPerEntity}，重置为默认值 ${DEFAULT_SETTINGS.maxBackupsPerEntity}`);
        settings.maxBackupsPerEntity = DEFAULT_SETTINGS.maxBackupsPerEntity;
    }

    if (typeof settings.backupDebounceDelay !== 'number' || settings.backupDebounceDelay < 300 || settings.backupDebounceDelay > 30000) {
        console.warn(`[聊天自动备份] 无效的防抖延迟 ${settings.backupDebounceDelay}，重置为默认值 ${DEFAULT_SETTINGS.backupDebounceDelay}`);
        settings.backupDebounceDelay = DEFAULT_SETTINGS.backupDebounceDelay;
    }

    console.log('[聊天自动备份] 插件设置初始化完成:', settings);
    return settings;
}

// --- IndexedDB 相关函数 ---
function initDatabase() {
    return new Promise((resolve, reject) => {
        logDebug('初始化 IndexedDB 数据库');
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = function(event) {
            console.error('[聊天自动备份] 打开数据库失败:', event.target.error);
            reject(event.target.error);
        };

        request.onsuccess = function(event) {
            const db = event.target.result;
            logDebug('数据库打开成功');
            resolve(db);
        };

        request.onupgradeneeded = function(event) {
            const db = event.target.result;
            console.log('[聊天自动备份] 数据库升级中，创建对象存储');
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: ['chatKey', 'timestamp'] });
                store.createIndex('chatKey', 'chatKey', { unique: false });
                console.log('[聊天自动备份] 创建了备份存储和索引');
            }
        };
    });
}

// 获取数据库连接 (优化版本 - 使用连接池)
async function getDB() {
    try {
        // 检查现有连接是否可用
        if (dbConnection && dbConnection.readyState !== 'closed') {
            return dbConnection;
        }
        
        // 创建新连接
        dbConnection = await initDatabase();
        return dbConnection;
    } catch (error) {
        console.error('[聊天自动备份] 获取数据库连接失败:', error);
        throw error;
    }
}

// 保存备份到 IndexedDB (优化版本)
async function saveBackupToDB(backup) {
    const db = await getDB();
    try {
        await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            
            transaction.oncomplete = () => {
                logDebug(`备份已保存到IndexedDB, 键: [${backup.chatKey}, ${backup.timestamp}]`);
                resolve();
            };
            
            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 保存备份事务失败:', event.target.error);
                reject(event.target.error);
            };
            
            const store = transaction.objectStore(STORE_NAME);
            store.put(backup);
        });
    } catch (error) {
        console.error('[聊天自动备份] saveBackupToDB 失败:', error);
        throw error;
    }
}

// 从 IndexedDB 获取指定聊天的所有备份
async function getBackupsForChat(chatKey) {
    const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            
            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 获取备份事务失败:', event.target.error);
                reject(event.target.error);
            };
            
            const store = transaction.objectStore(STORE_NAME);
            const index = store.index('chatKey');
            const request = index.getAll(chatKey);
            
            request.onsuccess = () => {
                const backups = request.result || [];
                logDebug(`从IndexedDB获取了 ${backups.length} 个备份，chatKey: ${chatKey}`);
                resolve(backups);
            };
            
            request.onerror = (event) => {
                console.error('[聊天自动备份] 获取备份失败:', event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] getBackupsForChat 失败:', error);
        return []; // 出错时返回空数组
    }
}

// 从 IndexedDB 获取所有备份
async function getAllBackups() {
    const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            
            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份事务失败:', event.target.error);
                reject(event.target.error);
            };
            
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();
            
            request.onsuccess = () => {
                const backups = request.result || [];
                logDebug(`从IndexedDB获取了总共 ${backups.length} 个备份`);
                resolve(backups);
            };
            
            request.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份失败:', event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] getAllBackups 失败:', error);
        return [];
    }
}

// 从 IndexedDB 获取所有备份的主键 (优化清理逻辑)
async function getAllBackupKeys() {
    const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');

            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份键事务失败:', event.target.error);
                reject(event.target.error);
            };

            const store = transaction.objectStore(STORE_NAME);
            // 使用 getAllKeys() 只获取主键
            const request = store.getAllKeys();

            request.onsuccess = () => {
                // 返回的是键的数组，每个键是 [chatKey, timestamp]
                const keys = request.result || [];
                logDebug(`从IndexedDB获取了总共 ${keys.length} 个备份的主键`);
                resolve(keys);
            };

            request.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份键失败:', event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] getAllBackupKeys 失败:', error);
        return []; // 出错时返回空数组
    }
} 

// 从 IndexedDB 删除指定备份
async function deleteBackup(chatKey, timestamp) {
    const db = await getDB();
    try {
        await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            
            transaction.oncomplete = () => {
                logDebug(`已从IndexedDB删除备份, 键: [${chatKey}, ${timestamp}]`);
                resolve();
            };
            
            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 删除备份事务失败:', event.target.error);
                reject(event.target.error);
            };
            
            const store = transaction.objectStore(STORE_NAME);
            store.delete([chatKey, timestamp]);
        });
    } catch (error) {
        console.error('[聊天自动备份] deleteBackup 失败:', error);
        throw error;
    }
}

// --- 聊天信息获取 ---
function getCurrentChatKey() {
    const context = getContext();
    logDebug('获取当前聊天标识符, context:',
        {groupId: context.groupId, characterId: context.characterId, chatId: context.chatId});
    if (context.groupId) {
        const key = `group_${context.groupId}_${context.chatId}`;
        logDebug('当前是群组聊天，chatKey:', key);
        return key;
    } else if (context.characterId !== undefined && context.chatId) { // 确保chatId存在
        const key = `char_${context.characterId}_${context.chatId}`;
        logDebug('当前是角色聊天，chatKey:', key);
        return key;
    }
    console.warn('[聊天自动备份] 无法获取当前聊天的有效标识符 (可能未选择角色/群组或聊天)');
    return null;
}

function getCurrentChatInfo() {
    const context = getContext();
    let chatName = '当前聊天', entityName = '未知';

    if (context.groupId) {
        const group = context.groups?.find(g => g.id === context.groupId);
        entityName = group ? group.name : `群组 ${context.groupId}`;
        chatName = context.chatId || '新聊天'; // 使用更明确的默认名
        logDebug('获取到群组聊天信息:', {entityName, chatName});
    } else if (context.characterId !== undefined) {
        entityName = context.name2 || `角色 ${context.characterId}`;
        const character = context.characters?.[context.characterId];
        if (character && context.chatId) {
             // chat文件名可能包含路径，只取最后一部分
             const chatFile = character.chat || context.chatId;
             chatName = chatFile.substring(chatFile.lastIndexOf('/') + 1).replace('.jsonl', '');
        } else {
            chatName = context.chatId || '新聊天';
        }
        logDebug('获取到角色聊天信息:', {entityName, chatName});
    } else {
        console.warn('[聊天自动备份] 无法获取聊天实体信息，使用默认值');
    }

    return { entityName, chatName };
}

// --- Web Worker 通信 ---
// 发送数据到 Worker 并返回包含拷贝后数据的 Promise
function performDeepCopyInWorker(payload) {
    return new Promise((resolve, reject) => {
        if (!backupWorker) {
            return reject(new Error("Backup worker not initialized."));
        }

        const currentRequestId = ++workerRequestId;
        workerPromises[currentRequestId] = { resolve, reject };

        logDebug(`[主线程] 发送数据到 Worker (ID: ${currentRequestId}), Payload size: ${JSON.stringify(payload).length}`);
        try {
            // 发送API获取的数据，利用postMessage的隐式克隆
            backupWorker.postMessage({
                id: currentRequestId,
                payload: payload
            });
        } catch (error) {
             console.error(`[主线程] 发送消息到 Worker 失败 (ID: ${currentRequestId}):`, error);
             delete workerPromises[currentRequestId];
             reject(error);
        }
    });
}

// --- 核心备份逻辑封装 ---
async function executeBackupLogic_Core(settings, backupType = BACKUP_TYPE.STANDARD, attemptId, forceSave = false) {
    logDebug(`[Backup #${attemptId.toString().slice(-6)}] executeBackupLogic_Core started. Type: ${backupType}, ForceSave: ${forceSave}`);

    if (isBackupInProgress) {
        logDebug(`[Backup #${attemptId.toString().slice(-6)}] Core logic busy (isBackupInProgress=true). Aborting this attempt.`);
        return false;
    }
    isBackupInProgress = true;
    logDebug(`[Backup #${attemptId.toString().slice(-6)}] Acquired isBackupInProgress lock.`);

    try {
        const currentTimestamp = Date.now();
        logDebug(`[Backup #${attemptId.toString().slice(-6)}] 开始执行核心备份逻辑 @ ${new Date(currentTimestamp).toLocaleTimeString()}`);

        // 1. 获取当前上下文和关键信息
        const chatKey = getCurrentChatKey();
        if (!chatKey) {
            console.warn(`[Backup #${attemptId.toString().slice(-6)}] 无有效的聊天标识符，无法执行备份`);
            return false;
        }

        const { entityName, chatName } = getCurrentChatInfo();
        let fullChatContentArray = null; 
        let originalChatMessagesCount = 0;

        logDebug(`[Backup #${attemptId.toString().slice(-6)}] 准备备份聊天: ${entityName} - ${chatName}`);

        // 根据是否需要轮询来获取数据
        if (forceSave) {
            // 强制保存时进行轮询
            const MAX_POLL_ATTEMPTS = 2;
            const POLL_INTERVAL_MS = 350;
            let pollAttempts = 0;
            let serverChatContentArray = null;
            let serverChatMessages = [];
            let serverChatMetadata = {};
            let isSynced = false;

            if (currentBackupAttemptId !== attemptId) {
                logDebug(`[Backup #${attemptId.toString().slice(-6)}] Cancelled at start of executeBackupLogic_Core's main logic.`);
                return false;
            }

            while (pollAttempts < MAX_POLL_ATTEMPTS && !isSynced) {
                if (currentBackupAttemptId !== attemptId) {
                    logDebug(`[Backup #${attemptId.toString().slice(-6)}] Cancelled during polling loop (attempt #${pollAttempts + 1}).`);
                    return false;
                }
                pollAttempts++;
                logDebug(`[Backup #${attemptId.toString().slice(-6)}] Polling attempt #${pollAttempts}...`);

                let clientContext;
                try {
                    clientContext = getContext();
                    // --- 从后端API获取完整的聊天文件内容 ---
                    const contextForAPI = clientContext;
                    if (contextForAPI.groupId) {
                        const group = contextForAPI.groups?.find(g => g.id === contextForAPI.groupId);
                        const effectiveGroupChatId = group?.chat_id || contextForAPI.chatId;
                        if (!effectiveGroupChatId) throw new Error(`Group chat ID not found for group ${contextForAPI.groupId}`);
                        
                        const messagesFromAPI = await fetchGroupChatMessages(group.id, effectiveGroupChatId);
                        if (!messagesFromAPI) throw new Error("API for group messages returned null");
                        
                        // 2. 获取元数据 - 从当前加载的群组聊天中获取
                        serverChatMetadata = structuredClone(contextForAPI.chatMetadata || {}); // 群组元数据更多依赖前端
                        serverChatMessages = messagesFromAPI;
                        serverChatContentArray = [serverChatMetadata, ...serverChatMessages];
                    } else if (contextForAPI.characterId !== undefined) {
                        const character = characters[contextForAPI.characterId];
                        const effectiveCharChatFile = character?.chat || contextForAPI.chatId;
                        if (!effectiveCharChatFile) throw new Error(`Character chat file not found for charId ${contextForAPI.characterId}`);
                        
                        const contentFromAPI = await fetchCharacterChatContent(character.name, effectiveCharChatFile, character.avatar);
                        if (!contentFromAPI || contentFromAPI.length === 0) throw new Error("API for character chat returned null or empty");
                        
                        serverChatMetadata = contentFromAPI[0];
                        serverChatMessages = contentFromAPI.slice(1);
                        serverChatContentArray = contentFromAPI;
                    } else {
                        throw new Error("Cannot determine entity type for API call.");
                    }
                } catch (fetchOrContextError) {
                    console.error(`[Backup #${attemptId.toString().slice(-6)}] Error polling (attempt #${pollAttempts}):`, fetchOrContextError);
                    if (pollAttempts >= MAX_POLL_ATTEMPTS) break; // 超出次数则跳出循环
                    if (currentBackupAttemptId !== attemptId) { 
                        logDebug(`[Backup #${attemptId.toString().slice(-6)}] Cancelled while waiting after error.`); 
                        return false; 
                    }
                    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
                    continue;
                }

                // --- 数据比对逻辑 ---
                const clientChatMessages = clientContext.chat || [];
                logDebug(`[Backup #${attemptId.toString().slice(-6)}] Comparing: Client msgs=${clientChatMessages.length}, API msgs=${serverChatMessages.length}`);
                
                if (backupType === BACKUP_TYPE.STANDARD) {
                    if (clientChatMessages.length === serverChatMessages.length) {
                        if (clientChatMessages.length > 0) {
                            const clientLastMsg = clientChatMessages[clientChatMessages.length - 1];
                            const serverLastMsg = serverChatMessages[serverChatMessages.length - 1];
                            if (clientLastMsg.mes === serverLastMsg.mes && clientLastMsg.is_user === serverLastMsg.is_user) {
                                if (!clientLastMsg.is_user) { // AI message, check swipe state
                                    const clientSwipesLen = clientLastMsg.swipes ? clientLastMsg.swipes.length : 0;
                                    const serverSwipesLen = serverLastMsg.swipes ? serverLastMsg.swipes.length : 0;
                                    if (clientLastMsg.swipe_id === serverLastMsg.swipe_id && clientSwipesLen === serverSwipesLen) {
                                        isSynced = true;
                                    } else {
                                        logDebug(`[Backup #${attemptId.toString().slice(-6)}] STANDARD unsynced: swipe_id (C:${clientLastMsg.swipe_id} vs S:${serverLastMsg.swipe_id}) or swipes.length (C:${clientSwipesLen} vs S:${serverSwipesLen}) mismatch.`);
                                    }
                                } else { // User message
                                    isSynced = true;
                                }
                            } else { 
                                logDebug(`[Backup #${attemptId.toString().slice(-6)}] STANDARD unsynced: last msg content/user mismatch.`); 
                            }
                        } else { 
                            isSynced = true; // Both empty
                        }
                    }
                } else if (backupType === BACKUP_TYPE.SWIPE) {
                    if (clientChatMessages.length === serverChatMessages.length && clientChatMessages.length > 0) {
                        const clientLastMsg = clientChatMessages[clientChatMessages.length - 1];
                        const serverLastMsg = serverChatMessages[serverChatMessages.length - 1];
                        const clientSwipes = clientLastMsg.swipes || [];
                        const serverSwipes = serverLastMsg.swipes || [];
                        if (clientLastMsg.swipe_id === serverLastMsg.swipe_id && clientSwipes.length === serverSwipes.length) {
                            if (clientSwipes.length > 0 && clientLastMsg.swipe_id < clientSwipes.length && serverLastMsg.swipe_id < serverSwipes.length) {
                                if (clientSwipes[clientLastMsg.swipe_id] === serverSwipes[serverLastMsg.swipe_id]) {
                                    isSynced = true;
                                } else { 
                                    logDebug(`[Backup #${attemptId.toString().slice(-6)}] SWIPE unsynced: current swipe content mismatch.`); 
                                }
                            } else if (clientSwipes.length === 0) { // Both have no swipes, e.g. user message accidentally marked as SWIPE type
                                isSynced = true;
                            }
                        } else { 
                            logDebug(`[Backup #${attemptId.toString().slice(-6)}] SWIPE unsynced: swipe_id or swipes.length mismatch.`); 
                        }
                    } else if (clientChatMessages.length === 0 && serverChatMessages.length === 0) { 
                        isSynced = true; 
                    }
                }

                if (isSynced) {
                    logDebug(`[Backup #${attemptId.toString().slice(-6)}] Synced after ${pollAttempts} attempt(s).`);
                } else if (pollAttempts < MAX_POLL_ATTEMPTS) {
                    logDebug(`[Backup #${attemptId.toString().slice(-6)}] Not synced, waiting ${POLL_INTERVAL_MS}ms...`);
                    if (currentBackupAttemptId !== attemptId) { 
                        logDebug(`[Backup #${attemptId.toString().slice(-6)}] Cancelled while waiting for next poll.`); 
                        return false; 
                    }
                    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
                }
            } // End polling loop

            if (currentBackupAttemptId !== attemptId && !isSynced) {
                logDebug(`[Backup #${attemptId.toString().slice(-6)}] Cancelled after polling (not synced).`); 
                return false;
            }
            
            if (!isSynced) {
                logDebug(`[Backup #${attemptId.toString().slice(-6)}] NOT synced after ${MAX_POLL_ATTEMPTS} attempts. Using last API data.`);
                toastr.warning(`备份警告: 数据同步不完美，备份可能略旧`, '聊天自动备份', {timeOut: 7000});
            }
            
            fullChatContentArray = serverChatContentArray;
            originalChatMessagesCount = serverChatMessages.length;
        } else {
            // 非强制保存，直接获取API数据，不进行轮询
            logDebug(`[Backup #${attemptId.toString().slice(-6)}] 跳过轮询 (forceSave=false)，直接获取API数据...`);
            
            try {
                const context = getContext();
                if (context.groupId) {
                    const group = context.groups?.find(g => g.id === context.groupId);
                    const effectiveGroupChatId = group?.chat_id || context.chatId;
                    if (!effectiveGroupChatId) throw new Error(`Group chat ID not found for group ${context.groupId}`);
                    
                    const messagesFromAPI = await fetchGroupChatMessages(group.id, effectiveGroupChatId);
                    if (!messagesFromAPI) throw new Error("API for group messages returned null");
                    
                    const groupChatMetadata = structuredClone(context.chatMetadata || {});
                    fullChatContentArray = [groupChatMetadata, ...messagesFromAPI];
                    originalChatMessagesCount = messagesFromAPI.length;
                } else if (context.characterId !== undefined) {
                    const character = characters[context.characterId];
                    const effectiveCharChatFile = character?.chat || context.chatId;
                    if (!effectiveCharChatFile) throw new Error(`Character chat file not found for charId ${context.characterId}`);
                    
                    fullChatContentArray = await fetchCharacterChatContent(character.name, effectiveCharChatFile, character.avatar);
                    if (!fullChatContentArray || fullChatContentArray.length === 0) throw new Error("API for character chat returned null or empty");
                    
                    originalChatMessagesCount = fullChatContentArray.length - 1; // 第一个是元数据
                } else {
                    throw new Error("Cannot determine entity type for API call.");
                }
            } catch (error) {
                console.error(`[Backup #${attemptId.toString().slice(-6)}] 获取API数据失败:`, error);
                // 添加toastr提示，统一错误反馈方式
                toastr.error(`备份失败: ${error.message || '获取API数据出错'}`, '聊天自动备份');
                return false;
            }
        }

        if (!fullChatContentArray) { 
            console.error(`[Backup #${attemptId.toString().slice(-6)}] 无有效的聊天内容数据`);
            return false; 
        }

        const lastMsgIndex = originalChatMessagesCount > 0 ? originalChatMessagesCount - 1 : -1; //消息数组的索引
        const lastMessage = lastMsgIndex >= 0 && fullChatContentArray.length > 1 ? fullChatContentArray[lastMsgIndex+1] : null; // +1 因为元数据在前面
        // 修改这一行，确保预览文本先过滤再截取
        const lastMessagePreview = (() => {
            const fullMessageText = lastMessage?.mes || '';
            
            if (!fullMessageText && originalChatMessagesCount > 0) {
                return '(消息内容获取失败)';
            } else if (originalChatMessagesCount <= 0) {
                return '(空聊天)';
            }
            
            // 1. 更全面地过滤各种标签和格式
            let filteredFullMessage = fullMessageText
                // 特殊标签 - 使用更严格的正则表达式确保完全移除标签及其内容
                .replace(/<tableEdit>[\s\S]*?<\/tableEdit>/g, '')
                .replace(/<tableEdit[\s\S]*?<\/tableEdit>/g, '') // 额外匹配可能带属性的标签
                .replace(/<think>[\s\S]*?<\/think>/g, '')
                .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
                // 以防万一，再添加一个通用的表格相关标签过滤
                .replace(/<table[\s\S]*?<\/table>/g, '')
                .replace(/<tr[\s\S]*?<\/tr>/g, '')
                .replace(/<td[\s\S]*?<\/td>/g, '')
                // 代码块
                .replace(/```[\s\S]*?```/g, '')
                .replace(/`[^`\n]*?`/g, '')
                // Markdown格式
                .replace(/\*\*(.*?)\*\*/g, '$1') // 移除粗体标记但保留内容
                .replace(/\*(.*?)\*/g, '$1')     // 移除斜体标记但保留内容
                .replace(/~~(.*?)~~/g, '$1')     // 移除删除线标记但保留内容
                // HTML标签 - 使用更严格的正则表达式
                .replace(/<[^>]*>[^<]*<\/[^>]*>/g, '') // 移除成对的HTML标签及其内容
                .replace(/<[^>]+>/g, '')               // 移除单个HTML标签
                // 其他可能的特殊格式
                .replace(/\[\[.*?\]\]/g, '')           // 移除[[]]格式
                .replace(/\[.*?\]\(.*?\)/g, '$1');     // 移除Markdown链接格式但保留文本
            
            // 2. 清理多余空白并截取
            return filteredFullMessage
                .replace(/\s+/g, ' ')  // 将多个空白字符替换为单个空格
                .trim()                // 去除首尾空格
                .substring(0, 150);    // 截取合适长度
        })();

        // 添加调试日志
        logDebug(`[Backup #${attemptId.toString().slice(-6)}] 生成的lastMessagePreview: ${lastMessagePreview}`);

        // 2. 使用 Worker 进行高效数据处理 (保留API获取的fullChatContentArray)
        let copiedFullChatContentArray;
        if (backupWorker) {
            try {
                console.time('[聊天自动备份] Web Worker 处理时间');
                logDebug(`[Backup #${attemptId.toString().slice(-6)}] 请求 Worker 处理 API获取的聊天数据（利用结构化克隆）...`);
                // Worker仅作为数据传递中介，利用postMessage的两次隐式克隆
                copiedFullChatContentArray = await performDeepCopyInWorker(fullChatContentArray);
                console.timeEnd('[聊天自动备份] Web Worker 处理时间');
                logDebug(`[Backup #${attemptId.toString().slice(-6)}] 从 Worker 收到处理后的聊天数据`);
            } catch(workerError) {
                console.error(`[Backup #${attemptId.toString().slice(-6)}] Worker 处理失败，将尝试在主线程处理:`, workerError);
                console.time('[聊天自动备份] 主线程处理时间 (Worker失败后)');
                try { 
                    copiedFullChatContentArray = structuredClone(fullChatContentArray); 
                } catch (scError) { 
                    copiedFullChatContentArray = JSON.parse(JSON.stringify(fullChatContentArray));
                }
                console.timeEnd('[聊天自动备份] 主线程处理时间 (Worker失败后)');
            }
        } else {
            console.time('[聊天自动备份] 主线程处理时间 (无Worker)');
            try { 
                copiedFullChatContentArray = structuredClone(fullChatContentArray); 
            } catch (scError) { 
                copiedFullChatContentArray = JSON.parse(JSON.stringify(fullChatContentArray));
            }
            console.timeEnd('[聊天自动备份] 主线程处理时间 (无Worker)');
        }
        
        if (!copiedFullChatContentArray) {
            throw new Error("未能获取有效的聊天数据副本 (fullChatContentArray)");
        }

        // 3. 构建备份对象
        const backup = {
            timestamp: currentTimestamp,
            chatKey, // 保持 chatKey 用于识别备份属于哪个原始聊天
            entityName,
            chatName,
            lastMessageId: lastMsgIndex, // 基于消息数量
            lastMessagePreview,
            // 存储完整的聊天文件内容数组
            chatFileContent: copiedFullChatContentArray, // [metadata, ...messages]
        };
        logDebug(`[Backup #${attemptId.toString().slice(-6)}] 构建的备份对象:`, {timestamp: backup.timestamp, chatKey: backup.chatKey, entityName: backup.entityName, chatName: backup.chatName, lastMessageId: backup.lastMessageId, preview: backup.lastMessagePreview, contentItems: backup.chatFileContent.length });

        // 4. 检查当前聊天是否已有基于最后消息ID的备份 (避免完全相同的备份)
        const existingBackups = await getBackupsForChat(chatKey);
        const existingBackupIndex = existingBackups.findIndex(b => b.lastMessageId === lastMsgIndex && b.lastMessageId !== -1); // 只有在有消息时才比较
        let needsSave = true;

        if (lastMsgIndex !== -1 && existingBackupIndex !== -1) {
            const existingTimestamp = existingBackups[existingBackupIndex].timestamp;
            if (backup.timestamp > existingTimestamp) {
                logDebug(`[Backup #${attemptId.toString().slice(-6)}] 发现旧备份 (ID ${lastMsgIndex}, 时间 ${existingTimestamp}), 将删除旧的以保存新的 (时间 ${backup.timestamp})`);
                await deleteBackup(chatKey, existingTimestamp);
            } else {
                logDebug(`[Backup #${attemptId.toString().slice(-6)}] 发现更新或相同的备份 (ID ${lastMsgIndex}, 时间 ${existingTimestamp} vs ${backup.timestamp}), 跳过保存`);
                needsSave = false;
            }
        }

        if (!needsSave) {
            logDebug(`[Backup #${attemptId.toString().slice(-6)}] 无需保存 (已存在或无更新), 跳过保存和清理`);
            return false;
        }

        // 5. 保存新的备份
        await saveBackupToDB(backup);
        logDebug(`[Backup #${attemptId.toString().slice(-6)}] 新备份已保存: [${chatKey}, ${backup.timestamp}]`);

        // 6. 先清理当前角色/群组超出限制的备份
        const currentEntityBackups = await getBackupsForChat(chatKey);
        if (currentEntityBackups.length > settings.maxBackupsPerEntity) {
            // 按时间戳排序（升序，最旧的在前）
            currentEntityBackups.sort((a, b) => a.timestamp - b.timestamp);
            const numToDeleteForEntity = currentEntityBackups.length - settings.maxBackupsPerEntity;
            const backupsToDeleteForEntity = currentEntityBackups.slice(0, numToDeleteForEntity);
            
            logDebug(`[Backup #${attemptId.toString().slice(-6)}] 当前角色/群组备份数 (${currentEntityBackups.length}) 超出限制 (${settings.maxBackupsPerEntity})`);
            logDebug(`[Backup #${attemptId.toString().slice(-6)}] 准备删除该角色/群组 ${numToDeleteForEntity} 个最旧的备份`);
            
            for (const backupToDelete of backupsToDeleteForEntity) {
                await deleteBackup(backupToDelete.chatKey, backupToDelete.timestamp);
            }
            
            logDebug(`[Backup #${attemptId.toString().slice(-6)}] 已删除当前角色/群组的 ${numToDeleteForEntity} 个旧备份`);
        }

        // 7. 然后清理超出角色/群组数量限制的备份
        const allBackups = await getAllBackups();
        
        // 获取不同的角色/群组及其最新备份时间
        const entityMap = new Map(); // 键为entityName，值为{latestTimestamp, backups[]}
        
        for (const backup of allBackups) {
            const entityName = backup.entityName || '未知';
            
            if (!entityMap.has(entityName)) {
                entityMap.set(entityName, {
                    latestTimestamp: backup.timestamp,
                    backups: [backup]
                });
            } else {
                const entityData = entityMap.get(entityName);
                entityData.backups.push(backup);
                
                if (backup.timestamp > entityData.latestTimestamp) {
                    entityData.latestTimestamp = backup.timestamp;
                }
            }
        }
        
        // 转换为数组并按最新备份时间排序（降序，最新的在前）
        const sortedEntities = Array.from(entityMap.entries())
            .map(([name, data]) => ({
                name,
                latestTimestamp: data.latestTimestamp,
                backups: data.backups
            }))
            .sort((a, b) => b.latestTimestamp - a.latestTimestamp);
        
        logDebug(`[Backup #${attemptId.toString().slice(-6)}] 当前有 ${sortedEntities.length} 个不同角色/群组的备份`);
        
        // 如果角色/群组数超出限制，删除最旧访问的角色/群组的所有备份
        if (sortedEntities.length > settings.maxEntityCount) {
            // 获取要删除的角色/群组列表（最旧的优先删除）
            const entitiesToRemove = sortedEntities.slice(settings.maxEntityCount);
            
            logDebug(`[Backup #${attemptId.toString().slice(-6)}] 角色/群组数 (${sortedEntities.length}) 超出限制 (${settings.maxEntityCount})`);
            logDebug(`[Backup #${attemptId.toString().slice(-6)}] 准备删除 ${entitiesToRemove.length} 个最旧访问的角色/群组的所有备份`);
            
            // 删除每个要移除角色/群组的所有备份
            for (const entity of entitiesToRemove) {
                logDebug(`[Backup #${attemptId.toString().slice(-6)}] 删除角色/群组 "${entity.name}" 的所有备份 (${entity.backups.length} 个)`);
                
                for (const backupToDelete of entity.backups) {
                    await deleteBackup(backupToDelete.chatKey, backupToDelete.timestamp);
                }
            }
            
            logDebug(`[Backup #${attemptId.toString().slice(-6)}] 已删除 ${entitiesToRemove.length} 个角色/群组的所有备份`);
        }
        
        logDebug(`[Backup #${attemptId.toString().slice(-6)}] 聊天备份和清理成功: ${entityName} - ${chatName}`);
        return true;
    } catch (error) {
        console.error(`[Backup #${attemptId.toString().slice(-6)}] 备份或清理过程中发生错误:`, error);
        throw error;
    } finally {
        isBackupInProgress = false;
        logDebug(`[Backup #${attemptId.toString().slice(-6)}] Released isBackupInProgress lock in executeBackupLogic_Core's finally.`);
    }
}

// --- Conditional backup function ---
async function performBackupConditional(backupType = BACKUP_TYPE.STANDARD, forceSave = false) {
    const localAttemptId = Date.now() + Math.random(); // 增加随机数确保唯一性
    currentBackupAttemptId = localAttemptId; 
    logDebug(`[Backup #${localAttemptId.toString().slice(-6)}] performBackupConditional called. Type: ${backupType}, ForceSave: ${forceSave}`);

    const currentSettings = extension_settings[PLUGIN_NAME];
    if (!currentSettings) {
        console.error('[聊天自动备份] Could not get current settings, cancelling backup');
        return false;
    }

    const chatKey = getCurrentChatKey();
    if (!chatKey) {
        logDebug(`[Backup #${localAttemptId.toString().slice(-6)}] Could not get a valid chat identifier, cancelling backup`);
        return false;
    }
    
    try {
        // 仅在forceSave为true时调用saveChatConditional
        if (forceSave) {
            logDebug(`[Backup #${localAttemptId.toString().slice(-6)}] Force saving chat...`);
            await saveChatConditional();
            logDebug(`[Backup #${localAttemptId.toString().slice(-6)}] saveChatConditional completed.`);
        } else {
            logDebug(`[Backup #${localAttemptId.toString().slice(-6)}] Skipping force save.`);
        }

        // 在调用轮询核心前再次检查是否已被取消
        if (currentBackupAttemptId !== localAttemptId) {
            logDebug(`[Backup #${localAttemptId.toString().slice(-6)}] Cancelled before calling executeBackupLogic_Core.`);
            return false; 
        }
        
        // 传递forceSave参数
        const success = await executeBackupLogic_Core(currentSettings, backupType, localAttemptId, forceSave);
        
        if (success) {
            await updateBackupsList();
        }
        return success;
    } catch (error) {
        console.error(`[Backup #${localAttemptId.toString().slice(-6)}] Conditional backup execution failed:`, error);
        toastr.error(`Backup failed: ${error.message || 'Unknown error'}`, 'Chat Auto Backup');
        return false;
    }
}

// --- Debounced backup function (similar to saveChatDebounced) ---
function performBackupDebounced(backupType = BACKUP_TYPE.STANDARD) {
    // Get the context and settings at the time of scheduling
    const scheduledChatKey = getCurrentChatKey();
    const currentSettings = extension_settings[PLUGIN_NAME];

    if (!scheduledChatKey) {
        logDebug('Could not get ChatKey at the time of scheduling debounced backup, cancelling');
        clearTimeout(backupTimeout);
        backupTimeout = null;
        return;
    }

    if (!currentSettings || typeof currentSettings.backupDebounceDelay !== 'number') {
        console.error('[聊天自动备份] Could not get valid debounce delay setting, cancelling debounced backup');
        clearTimeout(backupTimeout);
        backupTimeout = null;
        return;
    }

    const delay = currentSettings.backupDebounceDelay; // Use the current settings' delay

    logDebug(`Scheduling debounced backup (delay ${delay}ms), for ChatKey: ${scheduledChatKey}, Type: ${backupType}`);
    clearTimeout(backupTimeout); // Clear the old timer

    backupTimeout = setTimeout(async () => {
        const currentChatKey = getCurrentChatKey(); // Get the ChatKey at the time of execution

        // Crucial: Context check
        if (currentChatKey !== scheduledChatKey) {
            logDebug(`Context has changed (Current: ${currentChatKey}, Scheduled: ${scheduledChatKey}), cancelling this debounced backup`);
            backupTimeout = null;
            return; // Abort backup
        }

        logDebug(`Executing delayed backup operation (from debounce), ChatKey: ${currentChatKey}, Type: ${backupType}`);
        // 防抖备份不强制保存
        await performBackupConditional(backupType, false).catch(error => {
            console.error(`[聊天自动备份] 防抖备份事件 ${currentChatKey} 处理失败:`, error);
        });
        backupTimeout = null; // Clear the timer ID
    }, delay);
}

// --- Manual backup ---
async function performManualBackup() {
    console.log('[聊天自动备份] Performing manual backup (calling conditional function)');
    try {
         await performBackupConditional(BACKUP_TYPE.STANDARD, true); // 手动备份使用强制保存
         toastr.success('恢复备份成功！', '聊天自动备份');
    } catch (error) {
         console.error('[聊天自动备份] Manual backup failed:', error);
    }
}

// --- Restore logic ---
async function restoreBackup(backupData) {
    logDebug('[聊天自动备份] 开始通过导入API恢复备份:', { chatKey: backupData.chatKey, timestamp: backupData.timestamp });
    logDebug('[聊天自动备份] 原始备份数据:', JSON.parse(JSON.stringify(backupData)));

    // 验证备份数据完整性
    if (!backupData.chatFileContent || !Array.isArray(backupData.chatFileContent) || backupData.chatFileContent.length === 0) {
        toastr.error('备份数据无效：缺少或空的 chatFileContent。', '恢复失败');
        console.error('[聊天自动备份] 备份数据无效，无法恢复。');
        return false;
    }

    // 从 backupData 中获取 entityName 和 chatName
    const originalEntityName = backupData.entityName || '未知实体';
    const originalChatName = backupData.chatName || '未知聊天';

    // 提取原始实体ID
    const isGroupBackup = backupData.chatKey.startsWith('group_');
    let originalEntityId = null;
    
    if (isGroupBackup) {
        // 从 group_GROUPID_chatid 格式中提取 GROUPID
        const match = backupData.chatKey.match(/^group_([^_]+)_/);
        originalEntityId = match ? match[1] : null;
        logDebug(`[聊天自动备份] 从备份 chatKey 中提取的原始群组ID: ${originalEntityId}`);
    } else {
        // 从 char_CHARINDEX_chatid 格式中提取 CHARINDEX
        const match = backupData.chatKey.match(/^char_(\d+)_/);
        originalEntityId = match ? match[1] : null;
        logDebug(`[聊天自动备份] 从备份 chatKey 中提取的原始角色索引: ${originalEntityId}`);
    }

    if (!originalEntityId) {
        toastr.error('无法从备份数据中解析原始实体ID。', '恢复失败');
        console.error('[聊天自动备份] 无法解析原始实体ID，chatKey:', backupData.chatKey);
        return false;
    }

    // 从 chatFileContent 中分离元数据和消息
    const retrievedChatMetadata = structuredClone(backupData.chatFileContent[0]);
    const retrievedChat = structuredClone(backupData.chatFileContent.slice(1));

    if (typeof retrievedChatMetadata !== 'object' || !Array.isArray(retrievedChat)) {
        toastr.error('备份数据格式错误：无法分离元数据和消息。', '恢复失败');
        console.error('[聊天自动备份] 备份数据 chatFileContent 格式错误。');
        return false;
    }
    logDebug(`[聊天自动备份] 从备份中提取元数据 (keys: ${Object.keys(retrievedChatMetadata).length}) 和消息 (count: ${retrievedChat.length})`);

    // 注意: 移除多余的确认对话框，因为确认已在外部UI事件处理中完成

    // --- 2. 构建 .jsonl File 对象 ---
    logDebug('[聊天自动备份] 步骤2: 构建 .jsonl File 对象...');
    const jsonlString = constructJsonlString(retrievedChatMetadata, retrievedChat);
    if (!jsonlString) {
        toastr.error('无法构建 .jsonl 数据，恢复中止。', '恢复失败');
        return false;
    }

    const timestampSuffix = new Date(backupData.timestamp).toISOString().replace(/[:.]/g, '-');
    // 使用原始聊天名和备份时间戳来命名恢复的文件，增加可识别性
    const restoredInternalFilename = `${originalChatName}_restored_${timestampSuffix}.jsonl`;
    const chatFileObject = new File([jsonlString], restoredInternalFilename, { type: "application/json-lines" });
    logDebug(`[聊天自动备份] 已创建 File 对象: ${chatFileObject.name}, 大小: ${chatFileObject.size} bytes`);

    // --- 3. 获取当前上下文以确定导入目标 ---
    const currentContext = getContext();
    const formData = new FormData();
    formData.append('file', chatFileObject);
    formData.append('file_type', 'jsonl');

    let importUrl = '';
    let success = false;

    logDebug('[聊天自动备份] 步骤3: 准备调用导入API...');

    try {
        if (isGroupBackup) { // 恢复到原始群组
            const targetGroupId = originalEntityId; // 使用从备份中提取的原始群组ID
            const targetGroup = context.groups?.find(g => g.id === targetGroupId);
            
            if (!targetGroup) {
                toastr.error(`原始群组 (ID: ${targetGroupId}) 不存在，无法恢复。请确保该群组已经被加载或创建。`, '恢复失败');
                logDebug(`[聊天自动备份] 找不到原始群组 ${targetGroupId}，恢复失败。可用的群组IDs: ${context.groups?.map(g => g.id).join(', ') || '无'}`);
            return false;
        }
            
            logDebug(`[聊天自动备份] 准备将备份导入到原始群组: ${targetGroup.name} (ID: ${targetGroupId})`);

            importUrl = '/api/chats/group/import';
            formData.append('group_id', targetGroupId); // 使用原始群组ID

            const response = await fetch(importUrl, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: formData,
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: '未知API错误' }));
                throw new Error(`群组聊天导入API失败: ${response.status} - ${errorData.error}`);
            }
            
            const importResult = await response.json();
            logDebug(`[聊天自动备份] 群组聊天导入API响应:`, importResult);

            if (importResult.res) { // importResult.res 是新创建的聊天ID
                const newGroupChatId = importResult.res;
                logDebug(`[聊天自动备份] 群组聊天导入成功，新聊天ID: ${newGroupChatId}。`);

                // --- 新增：检查当前上下文是否需要切换到目标群组 ---
                const currentContextBeforeOpenGroup = getContext();
                if (String(currentContextBeforeOpenGroup.groupId) !== String(targetGroupId)) {
                    logDebug(`[聊天自动备份] 当前群组 (ID: ${currentContextBeforeOpenGroup.groupId}) 与目标恢复群组 (ID: ${targetGroupId}) 不同，select_group_chats 将处理切换...`);
                    // 在这种情况下 select_group_chats 将同时处理群组切换和聊天加载
                } else {
                    logDebug(`[聊天自动备份] 当前已在目标恢复群组 (ID: ${targetGroupId}) 上下文中，只需加载新聊天。`);
                    // 即使在同一群组中，select_group_chats 也应该正确处理只切换聊天而不重新加载整个群组的情况
                }
                // --- 检查逻辑结束 ---

                logDebug(`[聊天自动备份] 正在加载新导入的群组聊天: ${newGroupChatId} 到群组 ${targetGroupId}...`);
                await select_group_chats(targetGroupId, newGroupChatId); // 加载新导入的聊天
                
                toastr.success(`备份已作为新聊天 "${newGroupChatId}" 导入到群组 "${targetGroup.name}"！`);
                success = true;
        } else {
                throw new Error('群组聊天导入API未返回有效的聊天ID。');
            }
        } else if (!isGroupBackup) { // 恢复到原始角色
            const targetCharacterIndex = parseInt(originalEntityId, 10);
            
            if (isNaN(targetCharacterIndex) || targetCharacterIndex < 0 || targetCharacterIndex >= characters.length) {
                toastr.error(`备份中的原始角色索引 (${originalEntityId}) 无效或超出范围。`, '恢复失败');
                logDebug(`[聊天自动备份] 原始角色索引 ${originalEntityId} 无效，characters数组长度: ${characters.length}`);
                return false;
            }
            
            const targetCharacter = characters[targetCharacterIndex];
            if (!targetCharacter) {
                toastr.error(`无法找到备份对应的原始角色 (索引: ${targetCharacterIndex})。`, '恢复失败');
                return false;
            }
            
            logDebug(`[聊天自动备份] 准备将备份内容作为新聊天保存到原始角色: ${targetCharacter.name} (索引: ${targetCharacterIndex})`);

            // 对于角色，使用 /api/chats/save 来创建一个新的聊天文件
            const newChatIdForRole = chatFileObject.name.replace('.jsonl', '');
            const chatToSaveForRole = [retrievedChatMetadata, ...retrievedChat];

            const saveResponse = await fetch('/api/chats/save', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    ch_name: targetCharacter.name,
                    file_name: newChatIdForRole,
                    chat: chatToSaveForRole,
                    avatar_url: targetCharacter.avatar,
                    force: false // 保留false，避免意外覆盖，如有冲突将报错
                }),
            });
            
            if (!saveResponse.ok) {
                const errorText = await saveResponse.text();
                throw new Error(`保存角色聊天API失败: ${saveResponse.status} - ${errorText}`);
            }
            
            logDebug(`[聊天自动备份] 角色聊天内容已通过 /api/chats/save 保存为: ${newChatIdForRole}.jsonl`);

            // --- 新增：检查当前上下文是否需要切换到目标角色 ---
            const currentContextBeforeOpen = getContext();
            if (String(currentContextBeforeOpen.characterId) !== String(targetCharacterIndex)) {
                logDebug(`[聊天自动备份] 当前角色 (ID: ${currentContextBeforeOpen.characterId}) 与目标恢复角色 (索引: ${targetCharacterIndex}) 不同，执行切换...`);
                await selectCharacterById(targetCharacterIndex);
                // 在切换角色后，添加短暂延迟以确保SillyTavern的上下文和UI稳定
                await new Promise(resolve => setTimeout(resolve, 300)); 
                logDebug(`[聊天自动备份] 已切换到目标角色 (索引: ${targetCharacterIndex})`);
            } else {
                logDebug(`[聊天自动备份] 当前已在目标恢复角色 (索引: ${targetCharacterIndex}) 上下文中，无需切换角色。`);
            }
            // --- 检查和切换逻辑结束 ---

            // 打开新保存的聊天文件 (此时应该已经在正确的角色上下文中了)
            await openCharacterChat(newChatIdForRole);
            
            toastr.success(`备份已作为新聊天 "${newChatIdForRole}" 恢复到角色 "${targetCharacter.name}"！`);
            success = true;
        } else {
            toastr.error('未选择任何角色或群组，无法确定恢复目标。', '恢复失败');
            return false;
        }

        if (success) {
            logDebug('[聊天自动备份] 恢复流程成功完成。');
            // 刷新备份列表
            if (typeof updateBackupsList === 'function') {
                 await updateBackupsList(); 
            }
            
            // 立即自动关闭扩展面板和备份UI
            closeExtensionsAndBackupUI();
        }
        return success;

    } catch (error) {
        console.error(`[聊天自动备份] 通过导入API恢复备份时发生严重错误:`, error);
        toastr.error(`恢复备份失败: ${error.message}`, '恢复失败');
        return false;
    }
}

// --- 更新备份列表UI ---
async function updateBackupsList() {
    console.log('[聊天自动备份] 开始更新备份列表UI');
    const backupsContainer = $('#chat_backup_list');
    if (!backupsContainer.length) {
        console.warn('[聊天自动备份] 找不到备份列表容器元素 #chat_backup_list');
        return;
    }

    backupsContainer.html('<div class="backup_empty_notice">正在加载备份...</div>');

    try {
        const allBackups = await getAllBackups();
        backupsContainer.empty(); // 清空

        if (allBackups.length === 0) {
            backupsContainer.append('<div class="backup_empty_notice">暂无保存的备份</div>');
            return;
        }

        // 按时间降序排序
        allBackups.sort((a, b) => b.timestamp - a.timestamp);
        logDebug(`渲染 ${allBackups.length} 个备份`);

        allBackups.forEach(backup => {
            const date = new Date(backup.timestamp);
            const formattedDate = date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });

            // 添加调试日志
            logDebug(`原始 backup.lastMessagePreview: ${backup.lastMessagePreview}`);

            // 统一使用 filterSpecialTags 处理预览文本
            const previewText = (() => {
                try {
                    // 使用 filterSpecialTags 进行完整处理
                    const processedForDisplay = filterSpecialTags(backup.lastMessagePreview || '');
                    
                    // 添加调试日志
                    logDebug(`处理后的 previewText: ${processedForDisplay}`);
                    
                    const maxPreviewLength = 100;
                    return processedForDisplay.length > maxPreviewLength
                        ? processedForDisplay.slice(0, maxPreviewLength) + '...'
                        : processedForDisplay;
                } catch (error) {
                    console.error('[聊天自动备份] 处理预览文本时出错:', error);
                    return '(预览处理失败)';
                }
            })();

            const backupItem = $(`
                <div class="backup_item">
                    <div class="backup_info">
                        <div class="backup_header">
                            <span class="backup_entity" title="${backup.entityName}">${backup.entityName || '未知实体'}</span>
                            <span class="backup_chat" title="${backup.chatName}">${backup.chatName || '未知聊天'}</span>
                        </div>
                        <div class="backup_details">
                            <span class="backup_mesid">消息数: ${backup.lastMessageId + 1}</span>
                            <span class="backup_date">${formattedDate}</span>
                        </div>
                        <div class="backup_preview" title="${previewText}">${previewText}</div>
                    </div>
                    <div class="backup_actions">
                        <button class="menu_button backup_preview_btn" title="预览此备份的最后两条消息" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">预览</button>
                        <button class="menu_button backup_restore" title="恢复此备份到新聊天" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">恢复</button>
                        <button class="menu_button danger_button backup_delete" title="删除此备份" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">删除</button>
                    </div>
                </div>
            `);
            backupsContainer.append(backupItem);
        });

        console.log('[聊天自动备份] 备份列表渲染完成');
    } catch (error) {
        console.error('[聊天自动备份] 更新备份列表失败:', error);
        backupsContainer.html(`<div class="backup_empty_notice">加载备份列表失败: ${error.message}</div>`);
    }
}

// --- 初始化与事件绑定 ---
jQuery(async () => {
    console.log('[聊天自动备份] 插件开始加载...');

    // 初始化设置
    const settings = initSettings();

    // 防止重复初始化的标志位
    let isInitialized = false;

    // --- 将各个初始化步骤拆分成独立函数 ---
    
    // 初始化数据库
    const initializeDatabase = async () => {
        console.log('[聊天自动备份] 初始化数据库');
        try {
            await initDatabase();
            return true;
        } catch (error) {
            console.error('[聊天自动备份] 数据库初始化失败:', error);
            return false;
        }
    };
    
    // 初始化Web Worker
    const initializeWebWorker = () => {
        console.log('[聊天自动备份] 初始化Web Worker');
        try {
            const blob = new Blob([deepCopyLogicString], { type: 'application/javascript' });
            backupWorker = new Worker(URL.createObjectURL(blob));
            console.log('[聊天自动备份] Web Worker 已创建（优化版本 - 利用隐式克隆）');

            // 设置 Worker 消息处理器 (主线程)
            backupWorker.onmessage = function(e) {
                const { id, result, error } = e.data;
                const promise = workerPromises[id];
                
                if (promise) {
                    if (error) {
                        console.error(`[主线程] Worker 返回错误 (ID: ${id}):`, error);
                        promise.reject(new Error(error));
                    } else {
                        promise.resolve(result);
                    }
                    delete workerPromises[id];
                } else {
                    console.warn(`[主线程] 收到未知或已处理的 Worker 消息 (ID: ${id})`);
                }
            };

            // 设置 Worker 错误处理器 (主线程)
            backupWorker.onerror = function(error) {
                console.error('[聊天自动备份] Web Worker 发生错误:', error);
                 // 拒绝所有待处理的 Promise
                 Object.keys(workerPromises).forEach(id => {
                     workerPromises[id].reject(new Error('Worker encountered an unrecoverable error.'));
                     delete workerPromises[id];
                 });
                toastr.error('备份 Worker 发生错误，自动备份可能已停止', '聊天自动备份');
            };
            
            return true;
        } catch (workerError) {
            console.error('[聊天自动备份] 创建 Web Worker 失败:', workerError);
            backupWorker = null; // 确保 worker 实例为空
            toastr.error('无法创建备份 Worker，将回退到主线程备份（性能较低）', '聊天自动备份');
            return false;
        }
    };
    
    // 加载插件UI
    const initializePluginUI = async () => {
        console.log('[聊天自动备份] 初始化插件UI');
        try {
            // 加载模板
            const settingsHtml = await renderExtensionTemplateAsync(
                `third-party/${PLUGIN_NAME}`,
                'settings'
            );
            $('#extensions_settings').append(settingsHtml);
            console.log('[聊天自动备份] 已添加设置界面');

            // 设置控制项
            const $settingsBlock = $('<div class="chat_backup_control_item"></div>');
            $settingsBlock.html(`
                <div style="margin-bottom: 8px;">
                    <label style="display: inline-block; min-width: 120px;">防抖延迟 (ms):</label>
                    <input type="number" id="chat_backup_debounce_delay" value="${settings.backupDebounceDelay}" 
                        min="300" max="30000" step="100" title="编辑或删除消息后，等待多少毫秒再执行备份 (建议 1000-1500)" 
                        style="width: 80px;" />
                </div>
                <div style="margin-bottom: 8px;">
                    <label style="display: inline-block; min-width: 120px;">最大角色/群组数:</label>
                    <input type="number" id="chat_backup_max_entity" value="${settings.maxEntityCount}" 
                        min="1" max="10" step="1" title="保留多少个不同角色/群组的备份" 
                        style="width: 80px;" />
                </div>
                <div>
                    <label style="display: inline-block; min-width: 120px;">每组最大备份数:</label>
                    <input type="number" id="chat_backup_max_per_entity" value="${settings.maxBackupsPerEntity}" 
                        min="1" max="10" step="1" title="每个角色/群组保留多少个备份" 
                        style="width: 80px;" />
                </div>
            `);
            $('.chat_backup_controls').prepend($settingsBlock);
            
            // 设置使用说明按钮
            setupHelpButton();
            
            return true;
        } catch (error) {
            console.error('[聊天自动备份] 初始化插件UI失败:', error);
            return false;
        }
    };
    
    // 设置UI控件事件监听
    const setupUIEvents = () => {
        console.log('[聊天自动备份] 设置UI事件监听');
        
        // 添加最大备份数设置监听
        $(document).on('input', '#chat_backup_max_total', function() {
            const total = parseInt($(this).val(), 10);
            if (!isNaN(total) && total >= 1 && total <= 50) {
                settings.maxTotalBackups = total;
                logDebug(`系统最大备份数已更新为: ${total}`);
                saveSettingsDebounced();
            } else {
                logDebug(`无效的系统最大备份数输入: ${$(this).val()}`);
                $(this).val(settings.maxTotalBackups);
            }
        });

        // --- 使用事件委托绑定UI事件 ---
        $(document).on('click', '#chat_backup_manual_backup', performManualBackup);

        // 防抖延迟设置
        $(document).on('input', '#chat_backup_debounce_delay', function() {
            const delay = parseInt($(this).val(), 10);
            if (!isNaN(delay) && delay >= 300 && delay <= 30000) {
                settings.backupDebounceDelay = delay;
                logDebug(`防抖延迟已更新为: ${delay}ms`);
                saveSettingsDebounced();
            } else {
                logDebug(`无效的防抖延迟输入: ${$(this).val()}`);
                $(this).val(settings.backupDebounceDelay);
            }
        });

        // 恢复按钮
        $(document).on('click', '.backup_restore', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            logDebug(`点击恢复按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);

            button.prop('disabled', true).text('恢复中...'); // 禁用按钮并显示状态

            try {
                const db = await getDB();
                const backup = await new Promise((resolve, reject) => {
                    const transaction = db.transaction([STORE_NAME], 'readonly');
                    
                    transaction.onerror = (event) => {
                        reject(event.target.error);
                    };
                    
                    const store = transaction.objectStore(STORE_NAME);
                    const request = store.get([chatKey, timestamp]);
                    
                    request.onsuccess = () => {
                        resolve(request.result);
                    };
                    
                    request.onerror = (event) => {
                        reject(event.target.error);
                    };
                });

                if (backup) {
                    // 判断是否需要显示确认对话框，使用localStorage检查
                    if (!hasUserConfirmedRestore()) {
                        // 第一次点击，显示确认对话框
                        if (confirm(`确定要恢复 " ${backup.entityName} - ${backup.chatName} " 的备份吗？\n\n插件将自动接管酒馆，并选中对应的角色/群组，并创建一个【新的聊天】来恢复备份内容。\n\n不论原有聊天记录是否存在，该备份恢复都不会影响任何原有的聊天记录，该备份也不会因为恢复备份而被删除，请勿担心。`)) {
                            // 用户确认了，将确认状态保存到localStorage
                            setUserConfirmedRestore(true);
                            await restoreBackup(backup);
                        } else {
                            // 用户取消确认对话框
                            console.log('[聊天自动备份] 用户取消恢复操作');
                        }
                    } else {
                        // 非第一次点击，直接恢复
                        await restoreBackup(backup);
                    }
                } else {
                    console.error('[聊天自动备份] 找不到指定的备份:', { timestamp, chatKey });
                    toastr.error('找不到指定的备份');
                }
            } catch (error) {
                console.error('[聊天自动备份] 恢复过程中出错:', error);
                toastr.error(`恢复过程中出错: ${error.message}`);
            } finally {
                button.prop('disabled', false).text('恢复'); // 恢复按钮状态
            }
        });

        // 删除按钮
        $(document).on('click', '.backup_delete', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            logDebug(`点击删除按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);

            const backupItem = button.closest('.backup_item');
            const entityName = backupItem.find('.backup_entity').text();
            const chatName = backupItem.find('.backup_chat').text();
            const date = backupItem.find('.backup_date').text();

            if (confirm(`确定要永久删除这个备份吗？\n\n实体: ${entityName}\n聊天: ${chatName}\n时间: ${date}\n\n此操作无法撤销！`)) {
                button.prop('disabled', true).text('删除中...');
                try {
                    await deleteBackup(chatKey, timestamp);
                    toastr.success('备份已删除');
                    backupItem.fadeOut(300, function() { $(this).remove(); }); // 平滑移除条目
                    // 可选：如果列表为空，显示提示
                    if ($('#chat_backup_list .backup_item').length <= 1) { // <=1 因为当前这个还在DOM里，将要移除
                        updateBackupsList(); // 重新加载以显示"无备份"提示
                    }
                } catch (error) {
                    console.error('[聊天自动备份] 删除备份失败:', error);
                    toastr.error(`删除备份失败: ${error.message}`);
                    button.prop('disabled', false).text('删除');
                }
            }
        });

        // 预览按钮
        $(document).on('click', '.backup_preview_btn', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            logDebug(`点击预览按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);
            button.prop('disabled', true).text('加载中...'); // 禁用按钮并显示状态
            
            try {
                const db = await getDB();
                const backup = await new Promise((resolve, reject) => {
                    const transaction = db.transaction([STORE_NAME], 'readonly');
                    
                    transaction.onerror = (event) => {
                        reject(event.target.error);
                    };
                    
                    const store = transaction.objectStore(STORE_NAME);
                    const request = store.get([chatKey, timestamp]);
                    
                    request.onsuccess = () => {
                        resolve(request.result);
                    };
                    
                    request.onerror = (event) => {
                        reject(event.target.error);
                    };
                });

                if (backup && backup.chatFileContent && Array.isArray(backup.chatFileContent) && backup.chatFileContent.length > 1) {
                    // 提取消息 (跳过索引0的元数据)
                    const messages = backup.chatFileContent.slice(1);
                    
                    if (messages.length > 0) {
                        // 获取最后两条消息
                        const lastMessages = messages.slice(-2);
                        
                        // 创建样式
                        const style = document.createElement('style');
                        style.textContent = `
                            .preview_container {
                                display: flex;
                                flex-direction: column;
                                padding: 0;
                                max-height: 80vh;
                                width: 100%;
                                background-color: #f9f9f9;
                                border-radius: 12px;
                                overflow: hidden;
                            }
                            
                            .preview_header {
                                background: linear-gradient(135deg, #3a6186, #89253e);
                                color: white;
                                padding: 15px 20px;
                                border-bottom: 1px solid #ddd;
                            }
                            
                            .preview_header h3 {
                                margin: 0 0 10px 0;
                                text-align: center;
                                font-size: 1.5em;
                            }
                            
                            .preview_metadata {
                                display: flex;
                                justify-content: space-between;
                                font-size: 0.9em;
                                flex-wrap: wrap;
                            }
                            
                            .meta_label {
                                font-weight: bold;
                                opacity: 0.8;
                            }
                            
                            .messages_container {
                                display: flex;
                                flex-direction: column;
                                padding: 20px;
                                gap: 15px;
                                overflow-y: auto;
                                max-height: calc(80vh - 100px);
                                background-image: url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADIAAAAyCAYAAAAeP4ixAAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAB3RJTUUH4AsEBR0P/P1PagAAAF5JREFUaN7t2CEOgEAQBMFB8P8/yxNgkQgMghyJqqqk6zY13W9Mktzs4DcAAADgGDMzM6/PIpKkUm4VkSSVq0hEV4SI7gZELggAAEBEQAAAAAACAgAAlKvc7JcJz20oNukgS4MAAAAASUVORK5CYII=');
                            }
                            
                            .message_box {
                                padding: 15px;
                                border-radius: 18px;
                                max-width: 75%;
                                color: white;
                                position: relative;
                                box-shadow: 0 1px 2px rgba(0,0,0,0.2);
                                word-break: break-word;
                                text-align: left !important; /* 强制左对齐 */
                            }
                            
                            /* 确保消息内部所有元素都左对齐 */
                            .message_box * {
                                text-align: left !important; /* 强制所有子元素左对齐 */
                            }
                            
                            /* 确保段落左对齐 */
                            .message_box p {
                                text-align: left !important;
                                margin: 0 0 10px 0;
                            }
                            
                            /* 确保Markdown生成的标签也左对齐 */
                            .message_box strong, 
                            .message_box em,
                            .message_box span,
                            .message_box div {
                                text-align: left !important;
                            }
                            
                            .user_message {
                                background-color: #8A2BE2;
                                align-self: flex-end;
                                border-bottom-right-radius: 4px;
                                margin-left: 25%;
                            }
                            
                            .assistant_message {
                                background-color: #FFA500;
                                align-self: flex-start;
                                border-bottom-left-radius: 4px;
                                margin-right: 25%;
                            }
                            
                            .user_message::after {
                                content: '';
                                position: absolute;
                                bottom: 0;
                                right: -10px;
                                width: 20px;
                                height: 20px;
                                background-color: #8A2BE2;
                                border-bottom-left-radius: 16px;
                                z-index: -1;
                            }
                            
                            .assistant_message::after {
                                content: '';
                                position: absolute;
                                bottom: 0;
                                left: -10px;
                                width: 20px;
                                height: 20px;
                                background-color: #FFA500;
                                border-bottom-right-radius: 16px;
                                z-index: -1;
                            }
                        `;
                        document.head.appendChild(style);
                        
                        // 创建预览容器，修改为flex布局的主容器
                        const previewContainer = document.createElement('div');
                        previewContainer.className = 'preview_container';

                        // 添加一个包含详细信息的标题区域
                        const headerSection = document.createElement('div');
                        headerSection.className = 'preview_header';

                        // 获取时间戳和实体名称信息
                        const timestamp = new Date(backup.timestamp).toLocaleString();
                        const entityName = backup.entityName || '未知角色/群组';
                        const messagesCount = backup.lastMessageId + 1; // +1因为lastMessageId是索引

                        headerSection.innerHTML = `
                            <h3>聊天记录预览</h3>
                            <div class="preview_metadata">
                                <div><span class="meta_label">来自:</span> ${entityName}</div>
                                <div><span class="meta_label">消息数:</span> ${messagesCount}</div>
                                <div><span class="meta_label">备份时间:</span> ${timestamp}</div>
                            </div>
                        `;

                        previewContainer.appendChild(headerSection);

                        // 创建消息容器，作为主容器的子元素
                        const messagesContainer = document.createElement('div');
                        messagesContainer.className = 'messages_container';
                        previewContainer.appendChild(messagesContainer);

                        // 将消息添加到消息容器中，而不是主容器
                        lastMessages.forEach((msg, index) => {
                            const messageDiv = document.createElement('div');
                            messageDiv.className = `message_box ${index % 2 === 0 ? 'user_message' : 'assistant_message'}`;
                            messageDiv.innerHTML = processMessage(msg.mes || msg);
                            messagesContainer.appendChild(messageDiv);
                        });
                        
                        // 在点击事件处理函数中使用：
                        const popup = new Popup(previewContainer, POPUP_TYPE.DISPLAY, '', {
                            wide: true,
                            large: true,
                            allowVerticalScrolling: false, // 因为我们已经在messages_container中实现了滚动
                            transparent: true // 移除弹窗的默认背景，使用我们自定义的背景
                        });
                        await popup.show();
                    }
                } else {
                    alert('无法加载预览内容或备份格式不正确');
                }
            } catch (error) {
                console.error('预览备份时出错:', error);
                alert('预览备份时出错: ' + error.message);
            } finally {
                button.prop('disabled', false).text('预览');
            }
        });

        // 调试开关
        $(document).on('change', '#chat_backup_debug_toggle', function() {
            settings.debug = $(this).prop('checked');
            console.log('[聊天自动备份] 调试模式已' + (settings.debug ? '启用' : '禁用'));
            saveSettingsDebounced();
        });
        
        // 监听扩展页面打开事件，刷新列表
        $(document).on('click', '#extensionsMenuButton', () => {
            if ($('#chat_auto_backup_settings').is(':visible')) {
                console.log('[聊天自动备份] 扩展菜单按钮点击，且本插件设置可见，刷新备份列表');
                setTimeout(updateBackupsList, 200); // 稍作延迟确保面板内容已加载
            }
        });

        // 抽屉打开时也刷新
        $(document).on('click', '#chat_auto_backup_settings .inline-drawer-toggle', function() {
            const drawer = $(this).closest('.inline-drawer');
            // 检查抽屉是否即将打开 (基于当前是否有 open class)
            if (!drawer.hasClass('open')) {
                console.log('[聊天自动备份] 插件设置抽屉打开，刷新备份列表');
                setTimeout(updateBackupsList, 50); // 几乎立即刷新
            }
        });

        // 添加最大角色/群组数设置监听
        $(document).on('input', '#chat_backup_max_entity', function() {
            const count = parseInt($(this).val(), 10);
            if (!isNaN(count) && count >= 1 && count <= 10) {
                settings.maxEntityCount = count;
                logDebug(`最大角色/群组数已更新为: ${count}`);
                saveSettingsDebounced();
            } else {
                logDebug(`无效的最大角色/群组数输入: ${$(this).val()}`);
                $(this).val(settings.maxEntityCount);
            }
        });
        
        // 添加每组最大备份数设置监听
        $(document).on('input', '#chat_backup_max_per_entity', function() {
            const count = parseInt($(this).val(), 10);
            if (!isNaN(count) && count >= 1 && count <= 10) {
                settings.maxBackupsPerEntity = count;
                logDebug(`每组最大备份数已更新为: ${count}`);
                saveSettingsDebounced();
            } else {
                logDebug(`无效的每组最大备份数输入: ${$(this).val()}`);
                $(this).val(settings.maxBackupsPerEntity);
            }
        });
    };
    
    // 初始化UI状态
    const initializeUIState = async () => {
        console.log('[聊天自动备份] 初始化UI状态');
        $('#chat_backup_debug_toggle').prop('checked', settings.debug);
        $('#chat_backup_debounce_delay').val(settings.backupDebounceDelay);
        $('#chat_backup_max_entity').val(settings.maxEntityCount);
        $('#chat_backup_max_per_entity').val(settings.maxBackupsPerEntity);
        
        // 检查用户是否已确认过恢复操作
        const confirmed = hasUserConfirmedRestore();
        logDebug(`[聊天自动备份] 加载用户恢复确认状态: ${confirmed}`);
        
        await updateBackupsList();
    };
    
    // 设置备份事件监听
    const setupBackupEvents = () => {
        console.log('[聊天自动备份] 设置备份事件监听 (优化版)');
        
        // 监听消息发送事件来设置标志
        if (event_types.MESSAGE_SENT) {
            eventSource.on(event_types.MESSAGE_SENT, () => {
                logDebug(`Event: MESSAGE_SENT`);
                // 设置标志，表示刚刚发送了消息
                messageSentRecently = true;
                
                // 清除任何现有的重置计时器
                if (messageSentResetTimer) {
                    clearTimeout(messageSentResetTimer);
                }
                
                // 10秒后自动重置标志，以防 GENERATION_STARTED 未触发
                messageSentResetTimer = setTimeout(() => {
                    messageSentRecently = false;
                    messageSentResetTimer = null;
                    logDebug(`自动重置 messageSentRecently 标志`);
                }, 10000);
            });
        }

        // 只有生成结束事件使用强制保存
        if (event_types.GENERATION_ENDED) {
            eventSource.on(event_types.GENERATION_ENDED, () => {
                logDebug(`Event: GENERATION_ENDED`);
                // 重置消息发送标志
                messageSentRecently = false;
                if (messageSentResetTimer) {
                    clearTimeout(messageSentResetTimer);
                    messageSentResetTimer = null;
                }
                
                performBackupConditional(BACKUP_TYPE.STANDARD, true).catch(e => 
                    console.error("GENERATION_ENDED backup error", e));
            });
        }

        // 修改用户发送消息后的生成启动事件
        if (event_types.GENERATION_STARTED) {
            eventSource.on(event_types.GENERATION_STARTED, () => {
                logDebug(`Event: GENERATION_STARTED (messageSentRecently: ${messageSentRecently})`);
                
                // 只有当最近发送过消息时才执行备份
                if (messageSentRecently) {
                    performBackupConditional(BACKUP_TYPE.STANDARD, false).catch(e => 
                        console.error("GENERATION_STARTED backup error", e));
                    
                    // 处理完毕后重置标志
                    messageSentRecently = false;
                    if (messageSentResetTimer) {
                        clearTimeout(messageSentResetTimer);
                        messageSentResetTimer = null;
                    }
                } else {
                    logDebug(`跳过 GENERATION_STARTED 事件的备份，因为不是由消息发送触发的`);
                }
            });
        }
        
        // CHARACTER_FIRST_MESSAGE_SELECTED改为防抖备份
        if (event_types.CHARACTER_FIRST_MESSAGE_SELECTED) {
            eventSource.on(event_types.CHARACTER_FIRST_MESSAGE_SELECTED, () => {
                logDebug(`Event: CHARACTER_FIRST_MESSAGE_SELECTED`);
                performBackupDebounced(BACKUP_TYPE.STANDARD);
            });
        }

        // 消息切换仍然是防抖备份SWIPE类型
        if (event_types.MESSAGE_SWIPED) {
            eventSource.on(event_types.MESSAGE_SWIPED, () => {
                logDebug(`Event: MESSAGE_SWIPED`);
                performBackupDebounced(BACKUP_TYPE.SWIPE); 
            });
        }
        
        // 消息更新仍然是防抖备份
        if (event_types.MESSAGE_UPDATED) { 
            eventSource.on(event_types.MESSAGE_UPDATED, () => {
                logDebug(`Event: MESSAGE_UPDATED`);
                performBackupDebounced(BACKUP_TYPE.STANDARD);
            });
        }

        // 其他防抖事件
        const otherDebouncedEvents = [
            event_types.IMAGE_SWIPED,
            event_types.MESSAGE_FILE_EMBEDDED,
            event_types.MESSAGE_REASONING_EDITED, 
            event_types.MESSAGE_REASONING_DELETED, 
            event_types.FILE_ATTACHMENT_DELETED, 
            event_types.GROUP_UPDATED
        ].filter(Boolean);

        otherDebouncedEvents.forEach(eventType => {
            if (eventType) {
                eventSource.on(eventType, () => {
                    logDebug(`Event (Other Debounced): ${eventType}`);
                    performBackupDebounced(BACKUP_TYPE.STANDARD); 
                });
            }
        });
        
        // 添加删除消息事件监听 - 使用强制保存确保最新状态
        if (event_types.MESSAGE_DELETED) {
            eventSource.on(event_types.MESSAGE_DELETED, () => {
                logDebug(`Event: MESSAGE_DELETED`);
                // 使用强制保存以确保获取最新状态
                performBackupConditional(BACKUP_TYPE.STANDARD, true).catch(e => 
                    console.error("MESSAGE_DELETED backup error", e));
            });
        }
        
        // 添加批量删除消息事件监听
        if (event_types.MESSAGES_DELETED) {
            eventSource.on(event_types.MESSAGES_DELETED, () => {
                logDebug(`Event: MESSAGES_DELETED`);
                // 使用强制保存以确保获取最新状态
                performBackupConditional(BACKUP_TYPE.STANDARD, true).catch(e => 
                    console.error("MESSAGES_DELETED backup error", e));
            });
        }
        
        logDebug('优化后的备份事件监听器设置完成。');
    };
    
    // 执行初始备份检查
    const performInitialBackupCheck = async () => {
        console.log('[聊天自动备份] 执行初始备份检查');
        try {
            const context = getContext();
            if (context.chat && context.chat.length > 0 && !isBackupInProgress) {
                logDebug('[聊天自动备份] 发现现有聊天记录，执行初始备份');
                await performBackupConditional(BACKUP_TYPE.STANDARD, true); // 初始备份应使用强制保存
            } else {
                logDebug('[聊天自动备份] 当前没有聊天记录或备份进行中，跳过初始备份');
            }
        } catch (error) {
            console.error('[聊天自动备份] 初始备份执行失败:', error);
        }
    };

    // --- 主初始化函数 ---
    const initializeExtension = async () => {
        if (isInitialized) {
            console.log('[聊天自动备份] 初始化已运行。跳过。');
            return;
        }
        isInitialized = true;
        console.log('[聊天自动备份] 由 app_ready 事件触发，运行初始化任务。');
        
        try {
            // 顺序执行初始化任务
            if (!await initializeDatabase()) {
                console.warn('[聊天自动备份] 数据库初始化失败，但将尝试继续');
            }
            
            initializeWebWorker();
            
            if (!await initializePluginUI()) {
                console.warn('[聊天自动备份] 插件UI初始化失败，但将尝试继续');
            }
            
            setupUIEvents();
            setupBackupEvents();
            setupKeyboardShortcuts(); // 添加这一行来设置快捷键
            
            await initializeUIState();
            
            // 移除旧的表格抽屉查找和设置代码，替换为新的轮询函数调用
            logDebug('[聊天自动备份] 初始化表格抽屉监听系统...');
            setupTableDrawerObserver();
            
            // 延迟一小段时间后执行初始备份检查，确保系统已经稳定
            setTimeout(performInitialBackupCheck, 1000);
            
            console.log('[聊天自动备份] 插件加载完成');
        } catch (error) {
            console.error('[聊天自动备份] 插件加载过程中发生严重错误:', error);
            $('#extensions_settings').append(
                '<div class="error">聊天自动备份插件加载失败，请检查控制台。</div>'
            );
        }
    };

    // --- 监听SillyTavern的app_ready事件 ---
    eventSource.on('app_ready', initializeExtension);
    
    // 如果事件已经错过，则直接初始化
    if (window.SillyTavern?.appReady) {
        console.log('[聊天自动备份] app_ready已发生，直接初始化');
        initializeExtension();
    } else {
        console.log('[聊天自动备份] 等待app_ready事件触发初始化');
        // 设置安全兜底，确保插件最终会初始化
        setTimeout(() => {
            if (!isInitialized) {
                console.warn('[聊天自动备份] app_ready事件未触发，使用兜底机制初始化');
                initializeExtension();
            }
        }, 3000); // 3秒后如果仍未初始化，则强制初始化
    }
});

function processMessage(messageText) {
    const startTime = performance.now();
    try {
        // 更严格的类型检查
        if (messageText === null || messageText === undefined) {
            return '(空消息)';
        }
        
        // 确保是字符串类型
        if (typeof messageText !== 'string') {
            if (typeof messageText === 'object' && messageText !== null) {
                // 尝试从对象中提取消息内容
                messageText = messageText.mes || String(messageText);
            } else {
                messageText = String(messageText);
            }
        }
        
        // 使用抽取的过滤函数
        let processed = filterSpecialTags(messageText);
        
        // 过滤代码块
        processed = processed
            .replace(/```[\s\S]*?```/g, '')
            .replace(/`[\s\S]*?`/g, '');
        
        // 处理连续空行和空白问题
        processed = processed
            .replace(/\n\s*\n\s*\n+/g, '\n\n')
            .trim()
            .replace(/ {2,}/g, ' ');
        
        // 简单的Markdown处理
        processed = processed
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/\n\n+/g, '</p><p class="message-paragraph">')
            .replace(/\n/g, '<br>');
        
        // 确保内容被段落包围
        if (!processed.startsWith('<p')) {
            processed = `<p class="message-paragraph">${processed}`;
        }
        if (!processed.endsWith('</p>')) {
            processed = `${processed}</p>`;
        }
        
        return processed;
    } catch (error) {
        console.error('[聊天自动备份] 消息处理失败:', error);
        return '(消息处理失败)';
    } finally {
        const endTime = performance.now();
        if (endTime - startTime > 100) { // 如果处理时间超过100ms
            console.warn('[聊天自动备份] 消息处理时间过长:', endTime - startTime, 'ms');
        }
    }
}

// 将现有的findTableDrawerElement函数替换为更健壮的版本
function findTableDrawerElement() {
    // 尝试查找表格抽屉元素
    const element = document.getElementById('table_drawer_content');
    if (element) {
        logDebug('[聊天自动备份] 成功找到表格抽屉元素');
    }
    return element;
}

// 添加新的轮询函数来重试查找表格抽屉元素
function setupTableDrawerObserver() {
    logDebug('[聊天自动备份] 开始设置表格抽屉监听器...');
    
    // 最大重试次数和间隔
    const MAX_RETRIES = 10;
    const RETRY_INTERVAL = 500; // 毫秒
    let retryCount = 0;
    
    function attemptToSetupObserver() {
        logDebug(`[聊天自动备份] 尝试查找表格抽屉元素 (尝试 ${retryCount+1}/${MAX_RETRIES})...`);
        
        tableDrawerElement = findTableDrawerElement();
        if (tableDrawerElement) {
            // 找到元素，设置监听器
            const drawerObserver = new MutationObserver(drawerObserverCallback);
            const drawerObserverConfig = {
                attributes: true,
                attributeFilter: ['style'], // 只监听style属性变化，更高效
            };
            drawerObserver.observe(tableDrawerElement, drawerObserverConfig);
            logDebug("[聊天自动备份] 已成功设置表格抽屉监听器");

            // 处理初始状态 (如果抽屉默认是打开的)
            if (window.getComputedStyle(tableDrawerElement).display !== 'none') {
                logDebug('[聊天自动备份] 表格抽屉在插件初始化时已打开。获取初始 chatMetadata 哈希...');
                const context = getContext();
                if (context && context.chatMetadata) {
                    try {
                        // 处理完整元数据
                        const metadataString = JSON.stringify(context.chatMetadata);
                        // 使用同步哈希函数无需await
                        metadataHashOnDrawerOpen = fastHash(metadataString);
                        logDebug(`[聊天自动备份] 初始打开状态的 chatMetadata 哈希: ${metadataHashOnDrawerOpen}`);
                    } catch (e) {
                        console.error('[聊天自动备份] 计算初始打开状态元数据哈希失败:', e);
                        metadataHashOnDrawerOpen = 'error_on_open';
                    }
                } else {
                    metadataHashOnDrawerOpen = null;
                }
            }
            return true; // 成功设置
        } else {
            retryCount++;
            if (retryCount < MAX_RETRIES) {
                // 继续重试
                logDebug(`[聊天自动备份] 未找到表格抽屉元素，${RETRY_INTERVAL}ms后重试...`);
                setTimeout(attemptToSetupObserver, RETRY_INTERVAL);
                return false; // 尚未成功设置
            } else {
                console.warn("[聊天自动备份] 达到最大重试次数，无法找到表格抽屉元素。");
                return false; // 最终失败
            }
        }
    }
    
    // 开始首次尝试
    return attemptToSetupObserver();
}

// --- 添加快捷键恢复功能 ---
function setupKeyboardShortcuts() {
    // 跟踪按键状态
    const keysPressed = {
        'KeyA': false,
        'KeyS': false,
        'KeyD': false
    };
    
    // 键盘按下事件
    document.addEventListener('keydown', (event) => {
        // 如果正在输入框中，不触发快捷键
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
            return;
        }
        
        // 更新按键状态
        if (event.code in keysPressed) {
            keysPressed[event.code] = true;
        }
        
        // 检查是否所有必需的键都被按下
        if (keysPressed['KeyA'] && keysPressed['KeyS'] && keysPressed['KeyD']) {
            // 重置按键状态，防止重复触发
            keysPressed['KeyA'] = keysPressed['KeyS'] = keysPressed['KeyD'] = false;
            
            // 恢复最新备份
            restoreLatestBackup();
        }
    });
    
    // 键盘释放事件
    document.addEventListener('keyup', (event) => {
        // 更新按键状态
        if (event.code in keysPressed) {
            keysPressed[event.code] = false;
        }
    });
    
    // 页面失去焦点时重置所有按键状态
    window.addEventListener('blur', () => {
        Object.keys(keysPressed).forEach(key => {
            keysPressed[key] = false;
        });
    });
    
    logDebug('[聊天自动备份] 快捷键监听已设置 (A+S+D 同时按下可恢复最新备份)');
}

// 恢复最新备份的函数
async function restoreLatestBackup() {
    logDebug('[聊天自动备份] 通过快捷键尝试恢复最新备份');
    
    try {
        // 获取所有备份
        const allBackups = await getAllBackups();
        if (!allBackups || allBackups.length === 0) {
            toastr.warning('没有可用的备份', '快捷恢复');
            return;
        }
        
        // 按时间戳排序（降序，最新的在前）
        allBackups.sort((a, b) => b.timestamp - a.timestamp);
        
        // 获取最新的备份
        const latestBackup = allBackups[0];
        
        // 显示即将恢复的通知
        toastr.info(`正在恢复 "${latestBackup.entityName} - ${latestBackup.chatName}" 的最新备份...`, '快捷恢复');
        
        // 直接调用恢复功能，跳过确认对话框
        await restoreBackup(latestBackup);
        
        // 恢复成功通知已在restoreBackup函数中显示
    } catch (error) {
        console.error('[聊天自动备份] 快捷恢复最新备份时出错:', error);
        toastr.error(`恢复失败: ${error.message}`, '快捷恢复');
    }
}

// 修改为使用localStorage存储确认状态
// 不再使用简单的全局变量
function hasUserConfirmedRestore() {
    return localStorage.getItem('chat_backup_confirmed_restore') === 'true';
}

function setUserConfirmedRestore(confirmed) {
    localStorage.setItem('chat_backup_confirmed_restore', confirmed ? 'true' : 'false');
    logDebug(`[聊天自动备份] 用户恢复确认状态已保存为: ${confirmed}`);
}

// 添加一个函数来关闭扩展面板和备份UI
function closeExtensionsAndBackupUI() {
    // 关闭主扩展页面
    const extensionsBlock = $('#rm_extensions_block');
    if (extensionsBlock.length) {
        extensionsBlock.removeClass('openDrawer').addClass('closedDrawer');
        extensionsBlock.attr('data-slide-toggle', 'hidden');
        extensionsBlock.css('display', 'none');
    }
    
    // 关闭备份UI的内容部分
    const backupContent = $('#chat_auto_backup_settings .inline-drawer-content');
    if (backupContent.length) {
        backupContent.css('display', 'none');
        // 更新父元素的open类(如果存在)
        const drawerParent = backupContent.closest('.inline-drawer');
        if (drawerParent.length) {
            drawerParent.removeClass('open');
        }
    }
    
    logDebug('[聊天自动备份] 已关闭扩展面板和备份UI');
}

// 添加使用说明按钮的点击事件和弹窗功能
function setupHelpButton() {
    // 首先确保使用说明按钮已添加到HTML中
    if ($('#chat_backup_help_button').length === 0) {
        const helpButton = $('<button id="chat_backup_help_button" class="menu_button"><i class="fa-solid fa-circle-question"></i> 使用说明</button>');
        // 将按钮添加到调试开关后面
        $('.chat_backup_controls .chat_backup_control_item:first').after(
            $('<div class="chat_backup_control_item"></div>').append(helpButton)
        );
    }
    
    // 为使用说明按钮添加点击事件
    $(document).on('click', '#chat_backup_help_button', function() {
        showHelpPopup();
    });
}

// 使用说明弹窗内容和展示
function showHelpPopup() {
    const helpContent = `
    <div class="backup_help_popup">
        <style>
            .backup_help_popup {
                color: var(--SmText);
                font-family: Arial, sans-serif;
                line-height: 1.6;
                padding: 10px 20px;
                overflow-y: auto;
                max-height: 80vh;
                text-align: left;
            }
            .backup_help_popup h1 {
                font-size: 1.8em;
                color: var(--SmColor);
                margin-top: 30px;
                margin-bottom: 15px;
                padding-bottom: 8px;
                border-bottom: 1px solid var(--SmColor);
                text-align: left;
            }
            .backup_help_popup h1:first-child {
                margin-top: 10px;
            }
            .backup_help_popup p {
                margin: 12px 0;
                text-align: left;
            }
            .backup_help_popup ul, .backup_help_popup ol {
                margin: 15px 0;
                padding-left: 25px;
                text-align: left;
            }
            .backup_help_popup li {
                margin: 6px 0;
                text-align: left;
            }
            .backup_help_popup blockquote {
                background-color: rgba(128, 128, 128, 0.1);
                border-left: 4px solid var(--SmColor);
                margin: 20px 0;
                padding: 10px 15px;
                font-style: italic;
                text-align: left;
            }
            .backup_help_popup hr {
                border: none;
                height: 1px;
                background: linear-gradient(to right, transparent, var(--SmColor), transparent);
                margin: 25px 0;
            }
            .backup_help_popup strong {
                color: var(--SmColor);
                font-weight: bold;
            }
            .backup_help_popup code {
                background-color: rgba(0, 0, 0, 0.2);
                padding: 2px 4px;
                border-radius: 3px;
                font-family: monospace;
                font-size: 0.9em;
            }
            /* 只有最后的感谢信息居中 */
            .backup_help_popup .footer-thanks {
                text-align: center;
            }
        </style>
        <h1>插件介绍</h1>
        <p>该插件旨在帮助用户在<strong>聊天记录丢失</strong>（尤其是因<strong>切换预设、正则替换</strong>等情况）时，能够快速找回重要内容。</p>
        <ul>
            <li>插件会<strong>自动备份（默认）最近 3 条不同角色卡/群聊的聊天记录</strong>。</li>
            <li>每个角色卡/群聊的备份会<strong>实时更新</strong>为最新内容。</li>
            <li>若需增加备份角色卡/群聊数量，可在插件设置页面中进行调整。</li>
            <li><strong>最多支持 10 个角色卡/群聊</strong>，每组最多备份 <strong>3 条记录</strong>。</li>
        </ul>
        <blockquote>
            <p>注：防抖延迟与调试日志参数通常无需更改，主要供开发者调试使用。</p>
        </blockquote>
        <hr>
        <h1>使用方式</h1>
        <ul>
            <li>点击每条备份右侧的 <code>恢复</code> 按钮，即可<strong>一键恢复</strong>至对应角色卡/群聊。</li>
            <li><strong>电脑用户</strong>可通过同时按下 <code>A + S + D</code> 键，<strong>可以直接快速恢复</strong>备份记录。</li>
            <li>点击 <code>预览</code> 可查看该备份中的<strong>最后两条对话消息</strong>。</li>
            <li><code>删除</code> 按钮用于<strong>移除当前备份</strong>。</li>
        </ul>
        <hr>
        <h1>其他说明</h1>
        <p>插件备份的聊天记录与原记录<strong>完全一致</strong>，包括作者注释、记忆表格等内容。</p>
        <p><strong>恢复操作通过酒馆的标准后端 API</strong>（加载机制），确保数据完整且不会恢复失败。</p>
        <p>插件针对不同情景设有多种备份策略：</p>
        <ul>
            <li>对<strong>记忆表格</strong>进行专门监听和变更比较，确保编辑版本与聊天记录同步。</li>
            <li>针对高频事件（如 AI 回复）采用<strong>轮询+强制保存机制</strong>，确保不遗漏重要信息。</li>
            <li>对其他低频事件则尽可能<strong>模拟酒馆的自动保存机制</strong>。</li>
        </ul>
        <p>使用了 <strong>Web Worker 技术</strong>，确保插件运行不会影响酒馆的性能或流畅度（卡顿）。</p>
        <hr>
        <p class="footer-thanks" style="font-style: italic; margin-top: 20px;">如有其他问题、BUG 或建议，欢迎随时反馈！</p>
    </div>`;

    // 使用ST的Popup系统创建弹窗
    const popup = new Popup(helpContent, POPUP_TYPE.DISPLAY, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true
    });
    popup.show();
}

// 缓存常用的正则表达式
const SPECIAL_TAGS_REGEX = {
    // 特殊标签 - 使用更严格的正则表达式
    tableEdit: /<tableEdit>[\s\S]*?<\/tableEdit>/g,
    tableEditAttr: /<tableEdit[\s\S]*?<\/tableEdit>/g, // 额外匹配可能带属性的标签
    think: /<think>[\s\S]*?<\/think>/g,
    thinking: /<thinking>[\s\S]*?<\/thinking>/g,
    // 表格相关标签
    table: /<table[\s\S]*?<\/table>/g,
    tableRow: /<tr[\s\S]*?<\/tr>/g,
    tableCell: /<td[\s\S]*?<\/td>/g,
    // 代码块
    codeBlockTicks: /```[\s\S]*?```/g,
    inlineCode: /`[^`\n]*?`/g,
    // Markdown格式
    bold: /\*\*(.*?)\*\*/g,
    italic: /\*(.*?)\*/g,
    strikethrough: /~~(.*?)~~/g,
    // HTML标签
    htmlPair: /<[^>]*>[^<]*<\/[^>]*>/g, // 成对的HTML标签及其内容
    htmlTag: /<[^>]+>/g,                // 单个HTML标签
    // 其他特殊格式
    doubleBrackets: /\[\[(.*?)\]\]/g,
    markdownLink: /\[(.*?)\]\(.*?\)/g,
    // HTML转义
    htmlEscape: {
        amp: /&/g,
        lt: /</g,
        gt: />/g,
        quot: /"/g,
        apos: /'/g
    }
};

// 使用缓存的正则表达式
function filterSpecialTags(text) {
    if (typeof text !== 'string') {
        return '';
    }
    
    // 1. 先过滤特殊标签和格式
    let filtered = text
        // 特殊标签
        .replace(SPECIAL_TAGS_REGEX.tableEdit, '')
        .replace(SPECIAL_TAGS_REGEX.tableEditAttr, '')
        .replace(SPECIAL_TAGS_REGEX.think, '')
        .replace(SPECIAL_TAGS_REGEX.thinking, '')
        // 表格相关标签
        .replace(SPECIAL_TAGS_REGEX.table, '')
        .replace(SPECIAL_TAGS_REGEX.tableRow, '')
        .replace(SPECIAL_TAGS_REGEX.tableCell, '')
        // 代码块
        .replace(SPECIAL_TAGS_REGEX.codeBlockTicks, '')
        .replace(SPECIAL_TAGS_REGEX.inlineCode, '')
        // Markdown格式 - 保留内容
        .replace(SPECIAL_TAGS_REGEX.bold, '$1')
        .replace(SPECIAL_TAGS_REGEX.italic, '$1')
        .replace(SPECIAL_TAGS_REGEX.strikethrough, '$1')
        // HTML标签
        .replace(SPECIAL_TAGS_REGEX.htmlPair, '')
        .replace(SPECIAL_TAGS_REGEX.htmlTag, '')
        // 其他特殊格式
        .replace(SPECIAL_TAGS_REGEX.doubleBrackets, '$1')
        .replace(SPECIAL_TAGS_REGEX.markdownLink, '$1');
    
    // 2. 清理多余空白
    filtered = filtered.replace(/\s+/g, ' ').trim();
    
    // 3. 然后进行 HTML 转义
    return filtered
        .replace(SPECIAL_TAGS_REGEX.htmlEscape.amp, "&amp;")
        .replace(SPECIAL_TAGS_REGEX.htmlEscape.lt, "&lt;")
        .replace(SPECIAL_TAGS_REGEX.htmlEscape.gt, "&gt;")
        .replace(SPECIAL_TAGS_REGEX.htmlEscape.quot, "&quot;")
        .replace(SPECIAL_TAGS_REGEX.htmlEscape.apos, "&#039;");
}
