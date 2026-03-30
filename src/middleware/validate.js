// src/middleware/validate.js — Reusable validation middleware

'use strict';

const { validationResult, body, query, param } = require('express-validator');

/**
 * Run express-validator checks and return 400 if any fail.
 * Usage: router.post('/endpoint', validate([body('name').isString()]), handler)
 *
 * @param {import('express-validator').ValidationChain[]} validations
 * @returns {Function} Express middleware
 */
function validate(validations) {
    return async (req, res, next) => {
        await Promise.all(validations.map(v => v.run(req)));

        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: errors.array().map(e => ({
                    field: e.path,
                    message: e.msg,
                    value: e.value,
                })),
            });
        }

        next();
    };
}

module.exports = { validate, body, query, param };
