/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */
import {
  RenderedWatcher
} from "./chunk.UMPSPH77.js";
import {
  lockBodyScrolling,
  unlockBodyScrolling
} from "./chunk.VQZ46MYI.js";
import {
  parseSpaceDelimitedTokens
} from "./chunk.RMZ7BVDM.js";
import {
  WaShowEvent
} from "./chunk.4ZAKP7NY.js";
import {
  WaHideEvent
} from "./chunk.MQODJ75V.js";
import {
  WaAfterShowEvent
} from "./chunk.PX3HMKF7.js";
import {
  WaAfterHideEvent
} from "./chunk.3NKIHICW.js";
import {
  dialog_styles_default
} from "./chunk.VRQU2Y2Z.js";
import {
  isTopDismissible,
  registerDismissible,
  unregisterDismissible
} from "./chunk.52WA2DJO.js";
import {
  HasSlotController
} from "./chunk.RWNXKUCF.js";
import {
  animateWithClass
} from "./chunk.L6CIKOFQ.js";
import {
  e as e2
} from "./chunk.KWDPKKFO.js";
import {
  watch
} from "./chunk.PZAN6FPN.js";
import {
  WebAwesomeElement,
  e,
  n,
  t
} from "./chunk.LBLI4KS5.js";
import {
  LocalizeController
} from "./chunk.4QWUDRS5.js";
import {
  o
} from "./chunk.TLFIX76K.js";
import {
  x
} from "./chunk.BKE5EYM3.js";
import {
  __decorateClass
} from "./chunk.JHZRD2LV.js";

// src/components/dialog/dialog.ts
var WaDialog = class extends WebAwesomeElement {
  constructor() {
    super(...arguments);
    this.localize = new LocalizeController(this);
    this.hasSlotController = new HasSlotController(this, "footer", "header-actions", "label");
    this.renderedWatcher = new RenderedWatcher(this, (isRendered) => this.handleRenderedChange(isRendered));
    this.open = false;
    this.label = "";
    this.withoutHeader = false;
    this.lightDismiss = false;
    this.withFooter = false;
    this.handleDocumentKeyDown = (event) => {
      if (event.key === "Escape" && this.open && isTopDismissible(this)) {
        event.preventDefault();
        event.stopPropagation();
        this.requestClose(this.dialog);
      }
    };
  }
  firstUpdated() {
    if (this.open) {
      this.addOpenListeners();
      this.dialog.showModal();
      lockBodyScrolling(this);
      this.renderedWatcher.start(this.dialog);
    }
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.renderedWatcher.stop();
    unlockBodyScrolling(this);
    this.removeOpenListeners();
  }
  async requestClose(source) {
    const waHideEvent = new WaHideEvent({ source });
    this.dispatchEvent(waHideEvent);
    if (waHideEvent.defaultPrevented) {
      this.open = true;
      animateWithClass(this.dialog, "pulse");
      return;
    }
    this.removeOpenListeners();
    await animateWithClass(this.dialog, "hide");
    this.open = false;
    this.dialog.close();
    unlockBodyScrolling(this);
    this.renderedWatcher.stop();
    const trigger = this.originalTrigger;
    if (typeof trigger?.focus === "function") {
      setTimeout(() => trigger.focus());
    }
    this.dispatchEvent(new WaAfterHideEvent());
  }
  addOpenListeners() {
    document.addEventListener("keydown", this.handleDocumentKeyDown);
    registerDismissible(this);
  }
  removeOpenListeners() {
    document.removeEventListener("keydown", this.handleDocumentKeyDown);
    unregisterDismissible(this);
  }
  handleDialogCancel(event) {
    event.preventDefault();
    if (!this.dialog.classList.contains("hide") && event.target === this.dialog && isTopDismissible(this)) {
      this.requestClose(this.dialog);
    }
  }
  handleDialogClick(event) {
    const target = event.target;
    const button = target.closest('[data-dialog="close"]');
    if (button) {
      event.stopPropagation();
      this.requestClose(button);
    }
  }
  async handleDialogPointerDown(event) {
    if (event.target === this.dialog) {
      if (this.lightDismiss) {
        this.requestClose(this.dialog);
      } else {
        await animateWithClass(this.dialog, "pulse");
      }
    }
  }
  /**
   * Suspends the modal when third-party CSS (e.g. cookie banner blockers) hides an open dialog, so the page isn't
   * left scroll locked and inert. "open" stays true so the modal resumes if the dialog is rendered again.
   */
  handleRenderedChange(isRendered) {
    if (!this.open) {
      this.renderedWatcher.stop();
      return;
    }
    if (!isRendered && this.dialog.open) {
      this.removeOpenListeners();
      this.dialog.close();
      unlockBodyScrolling(this);
    } else if (isRendered && !this.dialog.open) {
      this.addOpenListeners();
      this.dialog.showModal();
      lockBodyScrolling(this);
    }
  }
  handleOpenChange() {
    if (this.open && !this.dialog.open) {
      this.show();
    } else if (!this.open && this.dialog.open) {
      this.open = true;
      this.requestClose(this.dialog);
    } else if (!this.open) {
      this.renderedWatcher.stop();
    }
  }
  /** Shows the dialog. */
  async show() {
    const waShowEvent = new WaShowEvent();
    this.dispatchEvent(waShowEvent);
    if (waShowEvent.defaultPrevented) {
      this.open = false;
      return;
    }
    this.addOpenListeners();
    this.originalTrigger = document.activeElement;
    this.open = true;
    this.dialog.showModal();
    lockBodyScrolling(this);
    this.renderedWatcher.start(this.dialog);
    requestAnimationFrame(() => {
      const elementToFocus = this.querySelector("[autofocus]");
      if (elementToFocus && typeof elementToFocus.focus === "function") {
        elementToFocus.focus();
      } else {
        this.dialog.focus();
      }
    });
    await animateWithClass(this.dialog, "show");
    this.dispatchEvent(new WaAfterShowEvent());
  }
  render() {
    const hasHeader = !this.withoutHeader;
    const hasFooter = this.hasSlotController.test("footer", "withFooter");
    return x`
      <dialog
        part="dialog"
        class=${e2({
      dialog: true,
      open: this.open
    })}
        @cancel=${this.handleDialogCancel}
        @click=${this.handleDialogClick}
        @pointerdown=${this.handleDialogPointerDown}
      >
        ${hasHeader ? x`
              <header part="header" class="header">
                <h2 part="title" class="title" id="title">
                  <!-- If there's no label, use an invisible character to prevent the header from collapsing -->
                  <slot name="label"> ${this.label.length > 0 ? this.label : String.fromCharCode(8203)} </slot>
                </h2>
                <div part="header-actions" class="header-actions">
                  <slot name="header-actions"></slot>
                  <wa-button
                    part="close-button"
                    exportparts="base:close-button__base"
                    class="close"
                    appearance="plain"
                    @click="${(event) => this.requestClose(event.target)}"
                  >
                    <wa-icon
                      name="xmark"
                      label=${this.localize.term("close")}
                      library="system"
                      variant="solid"
                    ></wa-icon>
                  </wa-button>
                </div>
              </header>
            ` : ""}

        <div part="body" class="body"><slot></slot></div>

        <!-- Use a hidden element so we still get "slotchange" events. -->
        <footer part="footer" class="footer" ?hidden=${!hasFooter}>
          <slot name="footer"></slot>
        </footer>
      </dialog>
    `;
  }
};
WaDialog.css = dialog_styles_default;
__decorateClass([
  e(".dialog")
], WaDialog.prototype, "dialog", 2);
__decorateClass([
  n({ type: Boolean, reflect: true })
], WaDialog.prototype, "open", 2);
__decorateClass([
  n({ reflect: true })
], WaDialog.prototype, "label", 2);
__decorateClass([
  n({ attribute: "without-header", type: Boolean, reflect: true })
], WaDialog.prototype, "withoutHeader", 2);
__decorateClass([
  n({ attribute: "light-dismiss", type: Boolean })
], WaDialog.prototype, "lightDismiss", 2);
__decorateClass([
  n({ attribute: "with-footer", type: Boolean })
], WaDialog.prototype, "withFooter", 2);
__decorateClass([
  watch("open", { waitUntilFirstUpdate: true })
], WaDialog.prototype, "handleOpenChange", 1);
WaDialog = __decorateClass([
  t("wa-dialog")
], WaDialog);
if (!o) {
  document.addEventListener("click", (event) => {
    const dialogAttrEl = event.target.closest("[data-dialog]");
    if (dialogAttrEl instanceof Element) {
      const [command, id] = parseSpaceDelimitedTokens(dialogAttrEl.getAttribute("data-dialog") || "");
      if (command === "open" && id?.length) {
        const doc = dialogAttrEl.getRootNode();
        const dialog = doc.getElementById(id);
        if (dialog?.localName === "wa-dialog") {
          dialog.open = true;
        } else {
          console.warn(`A dialog with an ID of "${id}" could not be found in this document.`);
        }
      }
    }
  });
  document.addEventListener("pointerdown", () => {
  });
}

export {
  WaDialog
};
