import * as routes from './vcpServerRoutes.js';

export const { normalizeVcpServerUrl, vcpServerEndpoint, vcpChatUrl } = routes.default ?? globalThis.vcpServerRoutes;