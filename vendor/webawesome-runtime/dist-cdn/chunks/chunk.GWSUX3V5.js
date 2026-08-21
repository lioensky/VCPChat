/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */

// src/internal/validators/required-validator.ts
var RequiredValidator = (options = {}) => {
  let { validationElement, validationProperty } = options;
  if (!validationElement) {
    if (typeof document !== "undefined" && "createElement" in document) {
      validationElement = Object.assign(document.createElement("input"), { required: true });
    }
  }
  if (!validationProperty) {
    validationProperty = "value";
  }
  const obj = {
    observedAttributes: ["required"],
    message: validationElement?.validationMessage,
    // @TODO: Add a translation.
    checkValidity(element) {
      const validity = {
        message: "",
        isValid: true,
        invalidKeys: []
      };
      const isRequired = element.required ?? element.hasAttribute("required");
      if (!isRequired) {
        return validity;
      }
      const value = element[validationProperty];
      const isEmpty = !value;
      if (isEmpty) {
        validity.message = typeof obj.message === "function" ? obj.message(element) : obj.message || "";
        validity.isValid = false;
        validity.invalidKeys.push("valueMissing");
      }
      return validity;
    }
  };
  return obj;
};

export {
  RequiredValidator
};
