/**
 * OCR Controller — API endpoints for the Hybrid Tiered OCR Pipeline
 * 
 * Superadmin-only manual trigger, status checking, and results retrieval.
 */

import { pool } from '../../DB/db.js'
import asyncHandler from '../../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../../Utils/errorHandler.util.js'
import apiResponse from '../../Utils/apiResponse.util.js'
import ocrPipelineQueue from '../../Workers/ocrPipeline.queue.js'

class OcrController {
    /**
     * Manually trigger OCR pipeline for a patient
     * POST /api/v2/ocr/trigger/:ipdId
     * Superadmin only
     */
    triggerPipeline = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { ipdId } = req.params
            const userId = req.user?.id
            const userRole = req.user?.role

            if (!userId) throw new apiError(401, 'No user found, please log in again')
            if (userRole !== 'superadmin') {
                throw new apiError(403, 'Access denied. Superadmin only.')
            }
            if (!ipdId) throw new apiError(400, 'Patient IPD ID is required')

            // Check patient exists
            const patientResult = await pool.query(
                `SELECT p.id, p.first_name, p.last_name, p.hospital_id
                 FROM ipds p WHERE p.id = $1`,
                [ipdId]
            )

            if ((patientResult.rowCount ?? 0) === 0) {
                throw new apiError(404, 'Patient not found')
            }

            const patient = patientResult.rows[0]

            // Check document count
            const docCount = await pool.query(
                `SELECT COUNT(*) as count FROM ipd_doc WHERE ipd_id = $1 AND s3_key IS NOT NULL`,
                [ipdId]
            )

            const count = parseInt(docCount.rows[0].count)
            if (count === 0) {
                throw new apiError(400, 'No documents found for this patient. Upload documents first.')
            }

            // Check if there's already a pending/processing episode
            const existingEpisode = await pool.query(
                `SELECT id, processing_status FROM canonical_episodes 
                 WHERE ipd_id = $1 AND processing_status IN ('pending', 'classifying', 'extracting', 'merging')
                 ORDER BY created_at DESC LIMIT 1`,
                [ipdId]
            )

            if ((existingEpisode.rowCount ?? 0) > 0) {
                const ep = existingEpisode.rows[0]
                throw new apiError(409, `OCR pipeline already in progress (status: ${ep.processing_status}). Wait for it to complete.`)
            }

            // Create new canonical episode record
            const episodeResult = await pool.query(
                `INSERT INTO canonical_episodes (ipd_id, processing_status, processing_started_at, triggered_by)
                 VALUES ($1, 'pending', NOW(), $2)
                 RETURNING id`,
                [ipdId, userId]
            )

            const episodeId = episodeResult.rows[0].id

            // Add job to Bull queue
            await ocrPipelineQueue.add({
                ipdId,
                episodeId,
                triggeredBy: userId,
            })

            console.log(`[OCR Controller] Pipeline triggered for ${patient.first_name} ${patient.last_name} (${count} docs)`)

            res.status(202).json(
                new apiResponse(202, {
                    episodeId,
                    patientName: `${patient.first_name} ${patient.last_name}`,
                    documentCount: count,
                    status: 'pending',
                    message: 'OCR pipeline queued. Use the status endpoint to track progress.',
                }, 'OCR pipeline triggered successfully')
            )
        }
    )

    /**
     * Get OCR processing status for a patient
     * GET /api/v2/ocr/status/:ipdId
     */
    getStatus = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { ipdId } = req.params
            const userId = req.user?.id

            if (!userId) throw new apiError(401, 'No user found, please log in again')
            if (!ipdId) throw new apiError(400, 'Patient IPD ID is required')

            const episodeResult = await pool.query(
                `SELECT ce.id, ce.processing_status, ce.completeness_score, ce.processing_cost_cents,
                        ce.tier_summary, ce.error_log, ce.processing_started_at, ce.processing_completed_at,
                        ce.created_at,
                        u.first_name as triggered_by_name
                 FROM canonical_episodes ce
                 LEFT JOIN users u ON ce.triggered_by = u.id
                 WHERE ce.ipd_id = $1
                 ORDER BY ce.created_at DESC
                 LIMIT 1`,
                [ipdId]
            )

            if ((episodeResult.rowCount ?? 0) === 0) {
                res.status(200).json(
                    new apiResponse(200, { status: 'none', message: 'No OCR processing found for this patient.' }, 'No OCR data')
                )
                return
            }

            const episode = episodeResult.rows[0]

            // Get per-document results count
            const docResults = await pool.query(
                `SELECT processing_status, COUNT(*) as count
                 FROM ocr_document_results
                 WHERE canonical_episode_id = $1
                 GROUP BY processing_status`,
                [episode.id]
            )

            const docStatusCounts: Record<string, number> = {}
            for (const row of docResults.rows) {
                docStatusCounts[row.processing_status] = parseInt(row.count)
            }

            // Calculate elapsed time
            let elapsedSeconds = null
            if (episode.processing_started_at) {
                const end = episode.processing_completed_at || new Date()
                elapsedSeconds = Math.round((new Date(end).getTime() - new Date(episode.processing_started_at).getTime()) / 1000)
            }

            res.status(200).json(
                new apiResponse(200, {
                    episodeId: episode.id,
                    status: episode.processing_status,
                    completenessScore: episode.completeness_score ? parseFloat(episode.completeness_score) : null,
                    costCents: episode.processing_cost_cents,
                    costDollars: episode.processing_cost_cents ? `$${(episode.processing_cost_cents / 100).toFixed(2)}` : null,
                    tierSummary: episode.tier_summary,
                    documentResults: docStatusCounts,
                    errorLog: episode.error_log,
                    triggeredBy: episode.triggered_by_name,
                    startedAt: episode.processing_started_at,
                    completedAt: episode.processing_completed_at,
                    elapsedSeconds,
                }, 'OCR status fetched')
            )
        }
    )

    /**
     * Get canonical JSON results for a patient
     * GET /api/v2/ocr/results/:ipdId
     */
    getResults = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { ipdId } = req.params
            const userId = req.user?.id

            if (!userId) throw new apiError(401, 'No user found, please log in again')
            if (!ipdId) throw new apiError(400, 'Patient IPD ID is required')

            const episodeResult = await pool.query(
                `SELECT id, episode_json, completeness_score, processing_status, 
                        processing_cost_cents, tier_summary, processing_completed_at
                 FROM canonical_episodes
                 WHERE ipd_id = $1 AND processing_status IN ('completed', 'partial')
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [ipdId]
            )

            if ((episodeResult.rowCount ?? 0) === 0) {
                throw new apiError(404, 'No completed OCR results found for this patient.')
            }

            const episode = episodeResult.rows[0]

            res.status(200).json(
                new apiResponse(200, {
                    episodeId: episode.id,
                    status: episode.processing_status,
                    completenessScore: parseFloat(episode.completeness_score),
                    costDollars: `$${(episode.processing_cost_cents / 100).toFixed(2)}`,
                    tierSummary: episode.tier_summary,
                    completedAt: episode.processing_completed_at,
                    canonicalJson: episode.episode_json,
                }, 'OCR results fetched')
            )
        }
    )

    /**
     * Get per-document OCR results for a patient
     * GET /api/v2/ocr/results/:ipdId/documents
     */
    getDocumentResults = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { ipdId } = req.params
            const userId = req.user?.id

            if (!userId) throw new apiError(401, 'No user found, please log in again')
            if (!ipdId) throw new apiError(400, 'Patient IPD ID is required')

            // Get the latest episode
            const episodeResult = await pool.query(
                `SELECT id FROM canonical_episodes WHERE ipd_id = $1 ORDER BY created_at DESC LIMIT 1`,
                [ipdId]
            )

            if ((episodeResult.rowCount ?? 0) === 0) {
                throw new apiError(404, 'No OCR processing found for this patient.')
            }

            const episodeId = episodeResult.rows[0].id

            const docsResult = await pool.query(
                `SELECT odr.id, odr.document_classification, odr.classification_confidence,
                        odr.complexity, odr.processing_tier, odr.extracted_json,
                        odr.processing_status, odr.cost_cents, odr.error_message,
                        odr.created_at,
                        id2.file_name, id2.type as original_type, id2.mime_type
                 FROM ocr_document_results odr
                 JOIN ipd_doc id2 ON odr.ipd_doc_id = id2.id
                 WHERE odr.canonical_episode_id = $1
                 ORDER BY odr.created_at`,
                [episodeId]
            )

            res.status(200).json(
                new apiResponse(200, {
                    episodeId,
                    totalDocuments: docsResult.rowCount,
                    documents: docsResult.rows.map((d: any) => ({
                        id: d.id,
                        fileName: d.file_name,
                        originalType: d.original_type,
                        mimeType: d.mime_type,
                        classifiedAs: d.document_classification,
                        confidence: parseFloat(d.classification_confidence),
                        complexity: d.complexity,
                        tier: d.processing_tier,
                        status: d.processing_status,
                        costCents: d.cost_cents,
                        extractedJson: d.extracted_json,
                        error: d.error_message,
                    })),
                }, 'Document results fetched')
            )
        }
    )
}

export default OcrController
