module.exports = {
    rules: {
        'at-rule-no-unknown': true,
        'block-no-empty': true,
        'color-no-invalid-hex': true,
        'declaration-block-no-duplicate-properties': true,
        'declaration-no-important': true,
        'font-family-no-duplicate-names': true,
        'function-no-unknown': [true, { ignoreFunctions: ['color-mix', 'superellipse'] }],
        'keyframe-block-no-duplicate-selectors': true,
        'no-duplicate-selectors': true,
        'property-no-unknown': [true, { ignoreProperties: ['corner-shape'] }],
        'selector-pseudo-element-no-unknown': true,
        'unit-no-unknown': true
    }
};
