/**
 * OCR Pipeline Worker — Bull queue orchestrator
 * 
 * Coordinates the entire Hybrid Tiered OCR Pipeline:
 * 1. Download documents from S3
 * 2. Classify with Gemini Flash
 * 3. Route to tiers (Tesseract / Gemini / GPT-4o / Photo)
 * 4. Merge results into canonical JSON
 * 5. Validate and store
 */

import Queue from 'bull'
import { pool } from '../DB/db.js'
import S3Service from '../Services/s3.service.js'
import ClassifierService, { type ClassifierInput, type ClassificationResult } from '../Services/ocr/classifier.service.js'
import TesseractService from '../Services/ocr/tesseract.service.js'
import GeminiExtractorService from '../Services/ocr/geminiExtractor.service.js'
import GPTExtractorService from '../Services/ocr/gptExtractor.service.js'
import PhotoAnnotatorService from '../Services/ocr/photoAnnotator.service.js'
import MergeEngine, { type TierOutput } from '../Services/ocr/mergeEngine.service.js'
import SchemaValidator from '../Services/ocr/schemaValidator.service.js'

// --- Types ---

interface OcrPipelineJob {
    ipdId: string
    episodeId: string
    triggeredBy: string
}

interface DownloadedDoc {
    ipdDocId: string
    buffer: Buffer
    mimeType: string
    fileName: string
    s3Key: string
    existingType: string
}

// --- Queue Setup ---

const ocrPipelineQueue = new Queue('ocr-pipeline', process.env.REDIS_URL || 'redis://localhost:6379', {
    defaultJobOptions: {
        attempts: 2,
        backoff: {
            type: 'exponential',
            delay: 5000,
        },
        removeOnComplete: 50,
        removeOnFail: 20,
    },
})

// --- Worker Process ---

ocrPipelineQueue.process(async (job) => {
    const { ipdId, episodeId, triggeredBy } = job.data as OcrPipelineJob

    console.log(`\n${'═'.repeat(60)}`)
    console.log(`[OCR Pipeline] STARTING for IPD: ${ipdId}`)
    console.log(`[OCR Pipeline] Episode: ${episodeId}`)
    console.log(`${'═'.repeat(60)}\n`)

    const startTime = Date.now()
    let totalCostCents = 0

    try {
        // ═══════════════════════════════════════════════════
        // STAGE 1: Update status → classifying
        // ═══════════════════════════════════════════════════
        await updateEpisodeStatus(episodeId, 'classifying')

        // ═══════════════════════════════════════════════════
        // STAGE 2: Download all documents from S3
        // ═══════════════════════════════════════════════════
        console.log(`[OCR Pipeline] Downloading documents from S3...`)
        const documents = await downloadPatientDocuments(ipdId)

        if (documents.length === 0) {
            throw new Error('No documents found for patient')
        }

        console.log(`[OCR Pipeline] ✓ Downloaded ${documents.length} documents`)
        job.progress(10)

        // ═══════════════════════════════════════════════════
        // STAGE 3: Classify all images
        // ═══════════════════════════════════════════════════
        console.log(`[OCR Pipeline] Classifying documents...`)

        const classifierInputs: ClassifierInput[] = documents.map((doc, i) => ({
            index: i,
            buffer: doc.buffer,
            mimeType: doc.mimeType,
            fileName: doc.fileName,
            ipdDocId: doc.ipdDocId,
            docType: doc.existingType,
        }))

        const classifications = await ClassifierService.classifyAll(classifierInputs)
        totalCostCents += 1 // ~$0.01 for classification

        job.progress(20)

        // ═══════════════════════════════════════════════════
        // STAGE 4: Route to tiers and extract concurrently
        // ═══════════════════════════════════════════════════
        await updateEpisodeStatus(episodeId, 'extracting')

        // Group documents by assigned tier
        const tierGroups: Record<string, Array<{ doc: DownloadedDoc; classification: ClassificationResult }>> = {
            tier_1_tesseract: [],
            tier_2_gemini: [],
            tier_3_gpt4o: [],
            tier_4_photo: [],
        }

        for (let i = 0; i < documents.length; i++) {
            const classification = classifications[i]
            if (!classification) continue

            const tier = classification.assigned_tier
            tierGroups[tier]!.push({ doc: documents[i]!, classification })
        }

        console.log(`[OCR Pipeline] Tier routing:`)
        console.log(`  Tier 1 (Tesseract): ${tierGroups.tier_1_tesseract!.length} docs`)
        console.log(`  Tier 2 (Gemini):    ${tierGroups.tier_2_gemini!.length} docs`)
        console.log(`  Tier 3 (GPT-4o):    ${tierGroups.tier_3_gpt4o!.length} docs`)
        console.log(`  Tier 4 (Photo):     ${tierGroups.tier_4_photo!.length} docs`)

        // Process all tiers concurrently
        const [tier1Results, tier2Results, tier3Results, tier4Results] = await Promise.all([
            processTier1(tierGroups.tier_1_tesseract!, episodeId),
            processTier2(tierGroups.tier_2_gemini!, episodeId),
            processTier3(tierGroups.tier_3_gpt4o!, episodeId),
            processTier4(tierGroups.tier_4_photo!, episodeId),
        ])

        job.progress(70)

        // Collect all results and costs
        const allResults: TierOutput[] = [...tier1Results.outputs, ...tier2Results.outputs, ...tier3Results.outputs, ...tier4Results.outputs]
        totalCostCents += tier1Results.cost + tier2Results.cost + tier3Results.cost + tier4Results.cost

        console.log(`[OCR Pipeline] ✓ Extraction complete. ${allResults.length} results, cost: ${totalCostCents} cents`)

        // ═══════════════════════════════════════════════════
        // STAGE 5: Merge all results
        // ═══════════════════════════════════════════════════
        await updateEpisodeStatus(episodeId, 'merging')
        console.log(`[OCR Pipeline] Merging results...`)

        const canonicalJson = MergeEngine.merge(allResults, totalCostCents)
        const completenessScore = MergeEngine.computeCompletenessScore(canonicalJson)

        job.progress(85)

        // ═══════════════════════════════════════════════════
        // STAGE 6: Validate and store
        // ═══════════════════════════════════════════════════
        const validation = SchemaValidator.validateEpisode(canonicalJson)

        if (!validation.valid) {
            console.warn(`[OCR Pipeline] Schema validation warnings:`, validation.errors)
        }

        // Store tier distribution summary
        const tierSummary = {
            tier_1_tesseract: { count: tierGroups.tier_1_tesseract!.length, cost: tier1Results.cost },
            tier_2_gemini: { count: tierGroups.tier_2_gemini!.length, cost: tier2Results.cost },
            tier_3_gpt4o: { count: tierGroups.tier_3_gpt4o!.length, cost: tier3Results.cost },
            tier_4_photo: { count: tierGroups.tier_4_photo!.length, cost: tier4Results.cost },
        }

        // Save to database
        await pool.query(
            `UPDATE canonical_episodes SET
                episode_json = $1,
                completeness_score = $2,
                processing_status = $3,
                processing_completed_at = NOW(),
                processing_cost_cents = $4,
                tier_summary = $5,
                error_log = $6
            WHERE id = $7`,
            [
                JSON.stringify(canonicalJson),
                completenessScore,
                completenessScore > 0 ? 'completed' : 'partial',
                totalCostCents,
                JSON.stringify(tierSummary),
                validation.valid ? null : `Schema warnings: ${validation.errors.join('; ')}`,
                episodeId,
            ]
        )

        job.progress(100)

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        console.log(`\n${'═'.repeat(60)}`)
        console.log(`[OCR Pipeline] ✓ COMPLETED`)
        console.log(`  IPD: ${ipdId}`)
        console.log(`  Documents: ${documents.length}`)
        console.log(`  Completeness: ${completenessScore}%`)
        console.log(`  Cost: $${(totalCostCents / 100).toFixed(2)}`)
        console.log(`  Time: ${elapsed}s`)
        console.log(`  Conflicts: ${canonicalJson.conflicts.length}`)
        console.log(`${'═'.repeat(60)}\n`)

        return { completenessScore, totalCostCents, documentCount: documents.length }

    } catch (error: any) {
        console.error(`[OCR Pipeline] ✗ FAILED for IPD ${ipdId}:`, error.message)

        await pool.query(
            `UPDATE canonical_episodes SET
                processing_status = 'failed',
                error_log = $1,
                processing_completed_at = NOW(),
                processing_cost_cents = $2
            WHERE id = $3`,
            [error.message, totalCostCents, episodeId]
        )

        throw error
    }
})

// --- Tier Processing Functions ---

async function processTier1(
    items: Array<{ doc: DownloadedDoc; classification: ClassificationResult }>,
    episodeId: string
): Promise<{ outputs: TierOutput[]; cost: number }> {
    const outputs: TierOutput[] = []
    let cost = 0
    const escalateToTier2: Array<{ doc: DownloadedDoc; classification: ClassificationResult }> = []

    for (const { doc, classification } of items) {
        const result = await TesseractService.processImage(doc.buffer, doc.mimeType, classification.document_type)

        if (result.escalate) {
            // Quality too low — escalate to Tier 2
            escalateToTier2.push({ doc, classification })
            await saveDocResult(episodeId, doc.ipdDocId, classification, 'tier_1_tesseract', {}, 0, 'escalated')
            continue
        }

        outputs.push({
            tier: 'tier_1_tesseract',
            documentType: classification.document_type,
            extractedJson: result.extractedJson,
            confidence: result.confidence,
            ipdDocId: doc.ipdDocId,
        })

        await saveDocResult(episodeId, doc.ipdDocId, classification, 'tier_1_tesseract', result.extractedJson, 0, 'completed')
    }

    // Process escalated docs through Tier 2
    if (escalateToTier2.length > 0) {
        console.log(`[OCR Tier1] Escalating ${escalateToTier2.length} docs to Tier 2`)
        const tier2Fallback = await processTier2(escalateToTier2, episodeId)
        outputs.push(...tier2Fallback.outputs)
        cost += tier2Fallback.cost
    }

    return { outputs, cost }
}

async function processTier2(
    items: Array<{ doc: DownloadedDoc; classification: ClassificationResult }>,
    episodeId: string
): Promise<{ outputs: TierOutput[]; cost: number }> {
    const outputs: TierOutput[] = []
    let cost = 0

    // Group by document type for batch extraction
    const byType = new Map<string, Array<{ doc: DownloadedDoc; classification: ClassificationResult }>>()
    for (const item of items) {
        const type = item.classification.document_type
        if (!byType.has(type)) byType.set(type, [])
        byType.get(type)!.push(item)
    }

    for (const [docType, group] of byType) {
        const images = group.map(g => ({ buffer: g.doc.buffer, mimeType: g.doc.mimeType }))
        const result = await GeminiExtractorService.extractGroup(images, docType)
        cost += result.costEstimateCents

        // If group extraction yielded a single result, share it across the group
        for (const { doc, classification } of group) {
            const status = result.success ? 'completed' : 'failed'

            // For low-confidence results, flag for potential GPT-4o re-processing
            if (result.success && result.confidence < 0.5) {
                console.log(`[OCR Tier2] Low confidence (${result.confidence}) for ${docType}, consider Tier 3`)
            }

            outputs.push({
                tier: 'tier_2_gemini',
                documentType: docType,
                extractedJson: result.extractedJson,
                confidence: result.confidence,
                ipdDocId: doc.ipdDocId,
            })

            await saveDocResult(episodeId, doc.ipdDocId, classification, 'tier_2_gemini', result.extractedJson, result.costEstimateCents, status)
        }
    }

    return { outputs, cost }
}

async function processTier3(
    items: Array<{ doc: DownloadedDoc; classification: ClassificationResult }>,
    episodeId: string
): Promise<{ outputs: TierOutput[]; cost: number }> {
    const outputs: TierOutput[] = []
    let cost = 0

    // Group by document type for batch extraction
    const byType = new Map<string, Array<{ doc: DownloadedDoc; classification: ClassificationResult }>>()
    for (const item of items) {
        const type = item.classification.document_type
        if (!byType.has(type)) byType.set(type, [])
        byType.get(type)!.push(item)
    }

    for (const [docType, group] of byType) {
        const images = group.map(g => ({ buffer: g.doc.buffer, mimeType: g.doc.mimeType }))
        const result = await GPTExtractorService.extractGroup(images, docType)
        cost += result.costEstimateCents

        for (const { doc, classification } of group) {
            outputs.push({
                tier: 'tier_3_gpt4o',
                documentType: docType,
                extractedJson: result.extractedJson,
                confidence: result.confidence,
                ipdDocId: doc.ipdDocId,
            })

            await saveDocResult(
                episodeId, doc.ipdDocId, classification, 'tier_3_gpt4o',
                result.extractedJson, result.costEstimateCents,
                result.success ? 'completed' : 'failed'
            )
        }
    }

    return { outputs, cost }
}

async function processTier4(
    items: Array<{ doc: DownloadedDoc; classification: ClassificationResult }>,
    episodeId: string
): Promise<{ outputs: TierOutput[]; cost: number }> {
    const outputs: TierOutput[] = []
    let cost = 0

    const images = items.map(i => ({ buffer: i.doc.buffer, mimeType: i.doc.mimeType }))
    const results = await PhotoAnnotatorService.annotateAll(images)

    for (let i = 0; i < items.length; i++) {
        const item = items[i]!
        const { doc, classification } = item
        const result = results[i]
        if (!result) continue

        cost += result.costEstimateCents

        outputs.push({
            tier: 'tier_4_photo',
            documentType: classification.document_type,
            extractedJson: result.extractedJson,
            confidence: result.extractedJson?.confidence ?? 0.7,
            ipdDocId: doc.ipdDocId,
        })

        await saveDocResult(
            episodeId, doc.ipdDocId, classification, 'tier_4_photo',
            result.extractedJson, Math.ceil(result.costEstimateCents),
            result.success ? 'completed' : 'failed'
        )
    }

    return { outputs, cost }
}

// --- Helper Functions ---

async function downloadPatientDocuments(ipdId: string): Promise<DownloadedDoc[]> {
    const docsResult = await pool.query(
        `SELECT id, s3_key, file_name, mime_type, type 
         FROM ipd_doc 
         WHERE ipd_id = $1 AND s3_key IS NOT NULL AND storage_provider = 's3'
         ORDER BY created_at`,
        [ipdId]
    )

    const documents: DownloadedDoc[] = []

    // Download in batches of 5 to not overload memory
    const BATCH_SIZE = 5
    for (let i = 0; i < docsResult.rows.length; i += BATCH_SIZE) {
        const batch = docsResult.rows.slice(i, i + BATCH_SIZE)
        const downloaded = await Promise.all(
            batch.map(async (doc: any) => {
                try {
                    const buffer = await S3Service.download(doc.s3_key)
                    return {
                        ipdDocId: doc.id,
                        buffer,
                        mimeType: doc.mime_type || 'image/jpeg',
                        fileName: doc.file_name || 'unknown',
                        s3Key: doc.s3_key,
                        existingType: doc.type || 'other',
                    }
                } catch (error: any) {
                    console.error(`[OCR Pipeline] Failed to download ${doc.s3_key}:`, error.message)
                    return null
                }
            })
        )
        documents.push(...downloaded.filter((d): d is DownloadedDoc => d !== null))
    }

    return documents
}

async function updateEpisodeStatus(episodeId: string, status: string): Promise<void> {
    await pool.query(
        `UPDATE canonical_episodes SET processing_status = $1 WHERE id = $2`,
        [status, episodeId]
    )
}

async function saveDocResult(
    episodeId: string,
    ipdDocId: string,
    classification: ClassificationResult,
    tier: string,
    extractedJson: Record<string, any>,
    costCents: number,
    status: string
): Promise<void> {
    await pool.query(
        `INSERT INTO ocr_document_results 
         (canonical_episode_id, ipd_doc_id, document_classification, classification_confidence, 
          complexity, processing_tier, extracted_json, cost_cents, processing_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
            episodeId,
            ipdDocId,
            classification.document_type,
            classification.confidence,
            classification.complexity,
            tier,
            JSON.stringify(extractedJson),
            costCents,
            status,
        ]
    )
}

// --- Queue Events ---

ocrPipelineQueue.on('completed', (job, result) => {
    console.log(`[OCR Pipeline] Job ${job.id} completed. Score: ${result?.completenessScore}%, Cost: $${((result?.totalCostCents || 0) / 100).toFixed(2)}`)
})

ocrPipelineQueue.on('failed', (job, err) => {
    console.error(`[OCR Pipeline] Job ${job?.id} failed:`, err.message)
})

ocrPipelineQueue.on('stalled', (job) => {
    console.warn(`[OCR Pipeline] Job ${job} stalled, will be retried`)
})

export default ocrPipelineQueue
