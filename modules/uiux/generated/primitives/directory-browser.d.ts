import type { UiScope } from '../contracts.js';
import { type ModalController } from './modal.js';
export interface DirectoryBrowserEntry {
    readonly name: string;
    readonly path: string;
    readonly hidden?: boolean;
}
export interface DirectoryBrowserListing {
    readonly path: string;
    readonly home?: string;
    readonly crumbs?: readonly DirectoryBrowserEntry[];
    readonly entries: readonly DirectoryBrowserEntry[];
    readonly truncated?: boolean;
}
export interface DirectoryBrowserProps {
    readonly open?: boolean;
    readonly busy?: boolean;
    readonly listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryBrowserListing>;
    readonly createDirectory: (path: string, name: string) => Promise<string>;
    readonly onOpen: (path: string) => void;
    readonly onClose: () => void;
    readonly title?: string;
    readonly cancelLabel?: string;
    readonly openLabel?: string;
    readonly newFolderLabel?: string;
    readonly showHiddenLabel?: string;
}
export interface DirectoryBrowserController {
    readonly modal: ModalController;
    readonly open: boolean;
    setOpen(open: boolean): void;
    setBusy(busy: boolean): void;
    dispose(): void | Promise<void>;
}
/**
 * Candidate-only Light-DOM Miller browser. All filesystem actions are injected
 * by its owner; it does not import Electron, invoke IPC, or retain a path.
 */
export declare function mountDirectoryBrowser(props: DirectoryBrowserProps, scope: UiScope): DirectoryBrowserController;
