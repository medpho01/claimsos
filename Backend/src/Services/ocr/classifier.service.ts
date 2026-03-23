/**
 * Classifier Service — Stage 1 of the Hybrid OCR Pipeline
 * 
 * Sends ALL patient images to Gemini 2.0 Flash in a single API call.
 * Returns per-image classification: document_type, complexity, confidence.
 * Maps complexity → tier with override rules.
 */

import { GoogleGenerativeAI, type Part } from '@google/generative-ai'

// --- Types ---

export interface ClassificationResult {
    image_index: number
    document_type: string
    complexity: 'simple' | 'standard' | 'complex' | 'photo'
    confidence: number
    reasoning: string
    assigned_tier: 'tier_1_tesseract' | 'tier_2_gemini' | 'tier_3_gpt4o' | 'tier_4_photo'
}

export interface ClassifierInput {
    index: number
    buffer: Buffer
    mimeType: string
    fileName: string
    ipdDocId: string
    docType?: string // existing type from ipd_doc table
}

// --- Constants ---

const CLASSIFIER_PROMPT = `You are a medical document classifier for Indian hospitals.

For each image, return a JSON array with:
- image_index: position in the input (0-based)
- document_type: one of [discharge_slip, lab_report, prescription, ot_note, icp_form, clinical_photo, xray, implant_invoice, consent_form, admission_form, post_op_report, treatment_chart, other]
- complexity: one of [simple, standard, complex, photo]
- confidence: 0.0 to 1.0
- reasoning: one line explaining your classification

Rules:
- "simple" = clearly printed text, tables, standard layouts
- "standard" = typed but with some handwritten fields, structured forms  
- "complex" = mostly handwritten, mixed formats, poor scan quality
- "photo" = clinical photos, X-rays, wound images (no text extraction needed)

Return ONLY a valid JSON array, no markdown, no explanation.`

const COMPLEXITY_TO_TIER: Record<string, string> = {
    simple: 'tier_1_tesseract',
    standard: 'tier_2_gemini',
    complex: 'tier_3_gpt4o',
    photo: 'tier_4_photo',
}

// Document types that should never be Tier 1
const MIN_TIER_2_TYPES = ['discharge_slip', 'surgical_discharge_slip']
// Document types that should always be Tier 3
const FORCE_TIER_3_TYPES = ['ot_note']

// --- Service ---

class ClassifierService {
    private genAI: GoogleGenerativeAI
    private model: any

    constructor() {
        const apiKey = process.env.GEMINI_API_KEY
        if (!apiKey) throw new Error('[OCR Classifier] GEMINI_API_KEY not set')

        this.genAI = new GoogleGenerativeAI(apiKey)
        this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })
    }

    /**
     * Classify all images in a single Gemini Flash call.
     * Gemini 2.0 Flash supports 1M context → handles 55+ images easily.
     */
    async classifyAll(images: ClassifierInput[]): Promise<ClassificationResult[]> {
        if (images.length === 0) return []

        console.log(`[OCR Classifier] Classifying ${images.length} images with Gemini Flash...`)
        const startTime = Date.now()

        try {
            // Build multimodal parts: text prompt + all images
            const parts: Part[] = [{ text: CLASSIFIER_PROMPT }]

            for (const img of images) {
                parts.push({
                    inlineData: {
                        mimeType: img.mimeType as any,
                        data: img.buffer.toString('base64'),
                    },
                })
            }

            const result = await this.model.generateContent(parts)
            const responseText = result.response.text()

            // Parse JSON from response (handle markdown code blocks)
            const jsonStr = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
            let classifications: any[]

            try {
                classifications = JSON.parse(jsonStr)
            } catch (parseErr) {
                console.error('[OCR Classifier] Failed to parse classifier response:', responseText.substring(0, 500))
                // Fallback: assign all to Tier 2 (safe default)
                return images.map((img, i) => ({
                    image_index: i,
                    document_type: img.docType || 'other',
                    complexity: 'standard' as const,
                    confidence: 0.5,
                    reasoning: 'Classifier parse failure — defaulting to Tier 2',
                    assigned_tier: 'tier_2_gemini' as const,
                }))
            }

            // Map and apply tier override rules
            const results: ClassificationResult[] = classifications.map((c: any, i: number) => {
                let tier = COMPLEXITY_TO_TIER[c.complexity] || 'tier_2_gemini'

                // Override rules
                if (c.confidence < 0.6) {
                    // Low confidence → bump up one tier
                    if (tier === 'tier_1_tesseract') tier = 'tier_2_gemini'
                    else if (tier === 'tier_2_gemini') tier = 'tier_3_gpt4o'
                }

                if (MIN_TIER_2_TYPES.includes(c.document_type) && tier === 'tier_1_tesseract') {
                    tier = 'tier_2_gemini'
                }

                if (FORCE_TIER_3_TYPES.includes(c.document_type)) {
                    tier = 'tier_3_gpt4o'
                }

                return {
                    image_index: c.image_index ?? i,
                    document_type: c.document_type || 'other',
                    complexity: c.complexity || 'standard',
                    confidence: c.confidence ?? 0.5,
                    reasoning: c.reasoning || '',
                    assigned_tier: tier as ClassificationResult['assigned_tier'],
                }
            })

            const elapsed = Date.now() - startTime
            console.log(`[OCR Classifier] ✓ Classified ${results.length} images in ${elapsed}ms`)

            // Log tier distribution
            const tierCounts: Record<string, number> = {}
            for (const r of results) {
                tierCounts[r.assigned_tier] = (tierCounts[r.assigned_tier] || 0) + 1
            }
            console.log(`[OCR Classifier] Tier distribution:`, tierCounts)

            return results
        } catch (error: any) {
            console.error(`[OCR Classifier] ✗ Classification failed:`, error.message)

            // Complete fallback: assign everything to Tier 2
            return images.map((img, i) => ({
                image_index: i,
                document_type: img.docType || 'other',
                complexity: 'standard' as const,
                confidence: 0.0,
                reasoning: `Classifier error: ${error.message}`,
                assigned_tier: 'tier_2_gemini' as const,
            }))
        }
    }
}

export default new ClassifierService()
