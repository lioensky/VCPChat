/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */

// src/internal/submit-on-enter.ts
function submitOnEnter(event, el) {
  const hasModifier = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  if (event.key === "Enter" && !hasModifier) {
    setTimeout(() => {
      if (!event.defaultPrevented && !event.isComposing) {
        submitForm(el);
      }
    });
  }
}
function submitForm(el) {
  let form = null;
  if ("form" in el) {
    form = el.form;
  }
  if (!form && "getForm" in el) {
    form = el.getForm();
  }
  if (!form) {
    return;
  }
  const formElements = [...form.elements];
  if (formElements.length === 1) {
    form.requestSubmit(null);
    return;
  }
  const button = formElements.find((el2) => el2.type === "submit" && !el2.matches(":disabled"));
  if (!button) {
    return;
  }
  if (["input", "button"].includes(button.localName)) {
    form.requestSubmit(button);
  } else {
    button.click();
  }
}

export {
  submitOnEnter,
  submitForm
};
