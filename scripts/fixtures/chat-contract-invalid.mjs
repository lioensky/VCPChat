import { assertChatEventContract } from '../../modules/chat/chatEventContract.js';

// Deliberately invalid fixture. The parent runner must observe a non-zero exit.
assertChatEventContract({ name: 'chat.stream.completed', terminal: false, durable: true });
