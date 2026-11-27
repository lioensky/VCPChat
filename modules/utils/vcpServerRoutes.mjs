import * as routes from './vcpServerRoutes.js';

export const { normalizeVcpServerUrl, vcpServerEndpoint, vcpChatUrl, postHumanTool } = routes.default ?? globalThis.vcpServerRoutes;