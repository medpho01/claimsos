/**
 * Schema Validator — JSON Schema validation for canonical episodes
 * 
 * Uses ajv to validate the canonical episode JSON against a defined schema.
 * Provides validation errors for debugging.
 */

import AjvModule from 'ajv'
const Ajv = AjvModule.default || AjvModule

// --- Canonical Episode JSON Schema ---

const CANONICAL_EPISODE_SCHEMA = {
    type: 'object',
    required: ['schema_version', 'meta', 'patient'],
    properties: {
        schema_version: { type: 'string' },
        meta: {
            type: 'object',
            required: ['generated_at', 'source_document_count'],
            properties: {
                generated_at: { type: 'string' },
                source_document_count: { type: 'integer', minimum: 0 },
                tier_distribution: { type: 'object' },
                total_cost_cents: { type: 'number', minimum: 0 },
            },
        },
        patient: {
            type: 'object',
            properties: {
                name: { type: ['string', 'null'] },
                age: { type: ['number', 'null'] },
                gender: { type: ['string', 'null'] },
                phone: { type: ['string', 'null'] },
                address: { type: ['string', 'null'] },
                insurance_id: { type: ['string', 'null'] },
            },
        },
        admission: {
            type: 'object',
            properties: {
                date: { type: ['string', 'null'] },
                type: { type: ['string', 'null'] },
                referring_doctor: { type: ['string', 'null'] },
                provisional_diagnosis: { type: ['string', 'null'] },
            },
        },
        diagnosis: {
            type: 'object',
            properties: {
                primary: { type: ['string', 'null'] },
                secondary: { type: 'array', items: { type: 'string' } },
            },
        },
        treatment: {
            type: 'object',
            properties: {
                procedure_name: { type: ['string', 'null'] },
                procedure_date: { type: ['string', 'null'] },
                surgeon: { type: ['string', 'null'] },
                assistant_surgeon: { type: ['string', 'null'] },
                anaesthetist: { type: ['string', 'null'] },
                anaesthesia_type: { type: ['string', 'null'] },
                surgical_approach: { type: ['string', 'null'] },
                procedure_details: { type: ['string', 'null'] },
                blood_loss_ml: { type: ['number', 'null'] },
                duration_minutes: { type: ['number', 'null'] },
                complications: { type: ['string', 'null'] },
                post_op_instructions: { type: 'array', items: { type: 'string' } },
            },
        },
        implant: {
            type: ['object', 'null'],
            properties: {
                name: { type: ['string', 'null'] },
                type: { type: ['string', 'null'] },
                size: { type: ['string', 'null'] },
                batch_no: { type: ['string', 'null'] },
                cost: { type: ['number', 'null'] },
            },
        },
        investigations: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    results: { type: 'array' },
                    date: { type: ['string', 'null'] },
                },
            },
        },
        medications: {
            type: 'object',
            properties: {
                during_stay: { type: 'array' },
                at_discharge: { type: 'array' },
            },
        },
        daily_progress: { type: 'array' },
        discharge: {
            type: 'object',
            properties: {
                date: { type: ['string', 'null'] },
                condition_at_discharge: { type: ['string', 'null'] },
                follow_up_instructions: { type: 'array', items: { type: 'string' } },
            },
        },
        financials: {
            type: 'object',
            properties: {
                total_bill: { type: ['number', 'null'] },
                gst_number: { type: ['string', 'null'] },
            },
        },
        clinical_photos: { type: 'array' },
        conflicts: { type: 'array' },
    },
    additionalProperties: false,
}

// --- Service ---

class SchemaValidatorService {
    private ajv: any
    private validate: any

    constructor() {
        this.ajv = new (Ajv as any)({ allErrors: true, strict: false })
        this.validate = this.ajv.compile(CANONICAL_EPISODE_SCHEMA)
    }

    /**
     * Validate a canonical episode JSON against the schema.
     * Returns { valid, errors }.
     */
    validateEpisode(episode: Record<string, any>): { valid: boolean; errors: string[] } {
        const valid = this.validate(episode)

        if (!valid) {
            const errors = (this.validate.errors || []).map((e: any) =>
                `${e.instancePath || '/'} ${e.message}` + (e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : '')
            )
            console.log(`[OCR Validator] ✗ Validation failed with ${errors.length} error(s)`)
            return { valid: false, errors }
        }

        console.log('[OCR Validator] ✓ Schema validation passed')
        return { valid: true, errors: [] }
    }
}

export default new SchemaValidatorService()
