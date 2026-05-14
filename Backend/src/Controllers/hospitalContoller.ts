import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import apiResponse from '../Utils/apiResponse.util.js'
import driveHandler from '../Services/driveUploader.service.js'
import fileName from '../Utils/fileName.util.js'
import { withTransaction } from '../Utils/transaction.util.js'

const DriveHandler = new driveHandler()
const FileName = new fileName()

import { z } from 'zod';

const optionalString = z.union([z.string(), z.number(), z.null(), z.undefined()]).transform(v => v ? String(v) : "");

const hospitalDetailsSchema = z.object({
    address: optionalString,
    locality: optionalString,
    region: optionalString,
    state: optionalString,
    district: optionalString,
    pinCode: optionalString,
    totalBeds: optionalString,
    specialities: optionalString,
    typeOfCare: optionalString,
    ownership: optionalString,
    validFromDate: optionalString,
    hfrId: optionalString,
    rohiniId: optionalString,
    registrationNumber: optionalString,
    registeringAuthority: optionalString,
    panNumber: optionalString,
    discountDeclaration: optionalString,
    contactPersonName: optionalString,
    contactNumber: optionalString,
    hospitalEmail: optionalString,
    tpaCoordinatorName: optionalString,
    tpaCoordinatorContact: optionalString,
    tpaCoordinatorEmail: optionalString,
    cmoName: optionalString,
    cmoContact: optionalString,
    cmoEmail: optionalString,
});

const rootId = (process.env.GOOGLE_DRIVE_ROOT_ID || process.env.PARENT) as string

class hospitalController {
    addHospital = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const adminId = req.user?.id
            if (!adminId) throw new apiError(401, 'Unauthorized')

            const { name, city, driveFolderId, details } = req.body

            if (!name || !city) throw new apiError(400, 'Provide name and city')

            // BE H4: DB-first, Drive after. Previously the folder was
            // created before the INSERT — if the INSERT failed (NOT NULL
            // violation in details, unique constraint, etc.) the folder
            // leaked into Drive with no cleanup. Insert with the caller's
            // drive_folder_id if supplied, otherwise NULL; then create
            // the folder out-of-band and UPDATE. The hospital row is the
            // source of truth — a missing folder is recoverable, a leaked
            // folder is not.
            const hospitalRes = await pool.query(
                'insert into hospitals (name,city,drive_folder_id,details) values ($1,$2,$3,$4) returning id, name, city, drive_folder_id, details, created_at',
                [name, city, driveFolderId || null, details || null]
            )

            if (hospitalRes.rowCount == 0)
                throw new apiError(
                    500,
                    'Somethng went wront while creating the hospital please try again'
                )

            const hospital = hospitalRes.rows[0]

            // Only auto-create a folder when the caller didn't pass one.
            if (!driveFolderId) {
                try {
                    const folder = await DriveHandler.createFolder(
                        FileName.folderName(name),
                        rootId
                    )
                    if (folder.fileId) {
                        const updateRes = await pool.query(
                            'update hospitals set drive_folder_id = $1 where id = $2 returning drive_folder_id',
                            [folder.fileId, hospital.id]
                        )
                        if (updateRes.rowCount && updateRes.rows[0]?.drive_folder_id) {
                            hospital.drive_folder_id = updateRes.rows[0].drive_folder_id
                        }
                    }
                } catch (driveErr) {
                    console.error(
                        '[ADD HOSPITAL] Drive folder creation failed for hospital',
                        hospital.id,
                        driveErr
                    )
                }
            }

            res.status(201).json(
                new apiResponse(
                    201,
                    hospital,
                    'Successfully added hospital'
                )
            )
        }
    )

    getAllHospitals = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const adminId = req.user?.id
            if (!adminId) throw new apiError(401, 'Unauthorized')
            const hospitalRes = await pool.query(
                `SELECT
                    h.id,
                    h.name,
                    h.city,
                    h.drive_folder_id,
                    h.details,
                    COALESCE(pc.panels_count, 0)::int   AS panels_count,
                    COALESCE(ic.patients_count, 0)::int AS patients_count
                 FROM hospitals h
                 LEFT JOIN (
                     SELECT hospital_id, COUNT(*) AS panels_count
                     FROM hospital_panels
                     GROUP BY hospital_id
                 ) pc ON pc.hospital_id = h.id
                 LEFT JOIN (
                     SELECT hospital_id, COUNT(*) AS patients_count
                     FROM ipds
                     WHERE is_active = true
                     GROUP BY hospital_id
                 ) ic ON ic.hospital_id = h.id
                 ORDER BY h.name`
            )
            res.status(200).json(
                new apiResponse(
                    200,
                    hospitalRes.rows,
                    'Successfully fetched all hospitals'
                )
            )
        }
    )

    getHospitalsByAdmin = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const adminId = req.params?.adminId || req.user?.id

            if (!adminId) throw new apiError(400, 'admin id is required')

            const hospitalResult = await pool.query(
                'SELECT hospital_id FROM hospital_assignments WHERE admin_id = $1',
                [adminId]
            )

            const hospitalIds = hospitalResult.rows.map((elem) => elem.hospital_id)
            const hospitalRes = await pool.query(
                'select id,name,city,drive_folder_id,details from hospitals where id = ANY($1)',
                [hospitalIds]
            )
            const hospitals = hospitalRes.rows;
            res.status(200).json(
                new apiResponse(
                    200,
                    hospitals,
                    'Successfully fetched Hospitals info by admin'
                )
            )
        }
    )

    addPanel = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const userId = req.user?.id
            const userRole = req.user?.role
            if (!userId) throw new apiError(401, 'Unauthorized')

            const {
                hospitalId,
                panelId,
                contact,
                sheetId,
                sheetName,
                whatsAppGroupId,
            } = req.body

            if (!hospitalId || !panelId) {
                throw new apiError(400, 'Hospital ID and Panel ID are required')
            }

            // For hospital users, verify they belong to this hospital
            let resolvedHospitalId = hospitalId
            if (userRole === 'hospital') {
                const userHospitalRes = await pool.query(
                    'SELECT hospital_id FROM hospital_users WHERE user_id = $1',
                    [userId]
                )
                if (userHospitalRes.rowCount === 0) {
                    throw new apiError(403, 'You are not assigned to any hospital')
                }
                resolvedHospitalId = userHospitalRes.rows[0].hospital_id
            }

            const hospitalRes = await pool.query(
                'select name,drive_folder_id from hospitals where id = $1',
                [resolvedHospitalId]
            )
            if (hospitalRes.rowCount == 0)
                throw new apiError(400, 'No such hospital exists')

            const panelRes = await pool.query(
                'select id,name from panels where id = $1',
                [panelId]
            )
            if (panelRes.rowCount == 0)
                throw new apiError(400, 'No such panel exists')

            // Check if panel is already linked to this hospital
            const existingLink = await pool.query(
                'SELECT id FROM hospital_panels WHERE hospital_id = $1 AND panel_id = $2',
                [resolvedHospitalId, panelId]
            )
            if (existingLink.rowCount !== 0) {
                // Backend review C7: previously this branch silently appended
                // the panelId to the calling hospital user's `role` array
                // (`array_append`), so any hospital user could self-grant
                // access to any panel in their hospital by sending the
                // panelId. Removed. Hospital users that need new panel
                // access should be granted it explicitly by an
                // admin/superadmin via updateHospitalUserRole.
                res.status(200).json(
                    new apiResponse(200, existingLink.rows[0], 'Panel already linked.')
                )
                return
            }

            // BE H4: DB-first, Drive after. Old code created the folder
            // before inserting hospital_panels and before the role-grant
            // UPDATE — if either failed the folder was orphaned. Wrap the
            // two DB writes in a real BEGIN/COMMIT and create the Drive
            // folder afterward, then UPDATE the row with the folder id.
            const panelRow = await withTransaction(async (client) => {
                const panelLink = await client.query(
                    'insert into hospital_panels (hospital_id,panel_id,whatsapp_group_id,sheet_id,sheet_name,drive_folder_id,contact) values ($1,$2,$3,$4,$5,$6,$7) returning *',
                    [
                        resolvedHospitalId,
                        panelId,
                        whatsAppGroupId,
                        sheetId,
                        sheetName,
                        null,
                        contact,
                    ]
                )
                if (panelLink.rowCount == 0)
                    throw new apiError(500, 'Something went wrong while linking panel')

                // For hospital users, automatically grant access to this panel
                if (userRole === 'hospital') {
                    await client.query(
                        `UPDATE hospital_users
                         SET role = array_append(role, $1)
                         WHERE user_id = $2 AND hospital_id = $3 AND NOT ($1 = ANY(role))`,
                        [panelId, userId, resolvedHospitalId]
                    )
                }

                return panelLink.rows[0]
            })

            // Drive folder is best-effort. A missing folder is recoverable
            // (admin can backfill); a leaked folder is not.
            try {
                const folder = await DriveHandler.createFolder(
                    FileName.folderName(panelRes.rows[0].name),
                    hospitalRes.rows[0].drive_folder_id
                )
                if (folder?.fileId) {
                    const updateRes = await pool.query(
                        'update hospital_panels set drive_folder_id = $1 where id = $2 returning drive_folder_id',
                        [folder.fileId, panelRow.id]
                    )
                    if (updateRes.rowCount && updateRes.rows[0]?.drive_folder_id) {
                        panelRow.drive_folder_id = updateRes.rows[0].drive_folder_id
                    }
                }
            } catch (driveErr) {
                console.error(
                    '[ADD PANEL] Drive folder creation failed for hospital_panel',
                    panelRow.id,
                    driveErr
                )
            }

            res.status(201).json(new apiResponse(201, panelRow, 'Panel linked successfully'))
        }
    )

    // ========== Master Panel Management ==========

    createMasterPanel = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            console.log('[createMasterPanel] Request received:', req.body)
            const { name } = req.body
            if (!name) throw new apiError(400, 'Panel name is required')

            // Check for duplicate
            const existingPanel = await pool.query(
                'SELECT id FROM panels WHERE LOWER(name) = LOWER($1)',
                [name]
            )
            console.log('[createMasterPanel] Existing panel check:', existingPanel.rowCount)
            if (existingPanel.rowCount !== 0) {
                throw new apiError(400, 'A panel with this name already exists')
            }

            const panelRes = await pool.query(
                'INSERT INTO panels (name) VALUES ($1) RETURNING id, name, created_at',
                [name]
            )
            console.log('[createMasterPanel] Insert result:', panelRes.rows)

            if (panelRes.rowCount === 0) {
                throw new apiError(500, 'Failed to create panel')
            }

            res.status(201).json(
                new apiResponse(201, panelRes.rows[0], 'Panel created successfully')
            )
        }
    )

    getAllMasterPanels = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const panelsRes = await pool.query(
                'SELECT id, name, created_at FROM panels ORDER BY name ASC'
            )
            res.status(200).json(
                new apiResponse(200, panelsRes.rows, 'Successfully fetched all panels')
            )
        }
    )

    // ========== Hospital Panel & User Queries ==========

    getHospitalPanels = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { hospitalId } = req.params
            const userId = req.user?.id
            const userRole = req.user?.role

            if (!hospitalId) throw new apiError(400, 'Hospital ID is required')

            let filterPanelIds: string[] | null = null;

            // If user is a hospital user, check their role assignments
            if (userRole === 'hospital' && userId) {
                const userAssignment = await pool.query(
                    'SELECT role FROM hospital_users WHERE user_id = $1 AND hospital_id = $2',
                    [userId, hospitalId]
                )

                if (userAssignment.rowCount && userAssignment.rowCount > 0) {
                    const roles = userAssignment.rows[0].role || [];
                    // If 'admin' is NOT in roles, restrict to assigned panels
                    if (!roles.includes('admin')) {
                        filterPanelIds = roles;
                    }
                    // If 'admin' IS present, filterPanelIds remains null (showing all panels)
                } else {
                    // Valid hospital user but not assigned to this hospital? 
                    // Should theoretically be caught by middleware or other checks, but safe to return empty
                    filterPanelIds = [];
                }
            }

            let query = `SELECT hp.id, hp.panel_id, p.name as panel_name, hp.whatsapp_group_id,
                        hp.sheet_id, hp.sheet_name, hp.drive_folder_id, hp.contact,
                        COUNT(i.id)::int AS total_count,
                        COUNT(i.id) FILTER (WHERE i.discharged_at IS NULL)::int AS admitted_count,
                        COUNT(i.id) FILTER (WHERE i.discharged_at IS NOT NULL)::int AS discharged_count
                 FROM hospital_panels hp
                 JOIN panels p ON hp.panel_id = p.id
                 LEFT JOIN ipds i ON i.hospital_panel_id = hp.id AND i.is_active = true
                 WHERE hp.hospital_id = $1`

            const queryParams: any[] = [hospitalId];

            if (filterPanelIds !== null) {
                query += ` AND hp.panel_id = ANY($2)`;
                queryParams.push(filterPanelIds);
            }

            query += ` GROUP BY hp.id, p.name ORDER BY p.name ASC`;

            const panelsRes = await pool.query(query, queryParams)

            res.status(200).json(
                new apiResponse(200, panelsRes.rows, 'Successfully fetched hospital panels')
            )
        }
    )

    getHospitalPanelsDetails = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { hospitalId } = req.params
            if (!hospitalId) throw new apiError(400, 'Hospital ID is required')

            const panelsRes = await pool.query(
                `SELECT
                hp.id, hp.hospital_id, hp.panel_id, p.name as panel_name, hp.whatsapp_group_id,
                hp.sheet_id, hp.sheet_name, hp.drive_folder_id, hp.contact,
                COUNT(i.id)::int AS total_count,
                COUNT(i.id) FILTER (WHERE i.discharged_at IS NULL)::int AS admitted_count,
                COUNT(i.id) FILTER (WHERE i.discharged_at IS NOT NULL)::int AS discharged_count
                FROM hospital_panels hp
                JOIN panels p ON hp.panel_id = p.id
                LEFT JOIN ipds i ON i.hospital_panel_id = hp.id AND i.is_active = true
                WHERE hp.hospital_id = $1
                GROUP BY hp.id, p.name
                ORDER BY p.name ASC`,
                [hospitalId]
            )

            res.status(200).json(
                new apiResponse(200, panelsRes.rows, 'Successfully fetched hospital panels')
            )
        }
    )

    getHospitalPatientsSummary = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { hospitalId } = req.params
            const userId = req.user?.id
            const userRole = req.user?.role

            if (!hospitalId) throw new apiError(400, 'Hospital ID is required')

            let filterPanelIds: string[] | null = null;

            if (userRole === 'hospital' && userId) {
                const userAssignment = await pool.query(
                    'SELECT role FROM hospital_users WHERE user_id = $1 AND hospital_id = $2',
                    [userId, hospitalId]
                )

                if (userAssignment.rowCount && userAssignment.rowCount > 0) {
                    const roles = userAssignment.rows[0].role || [];
                    if (!roles.includes('admin')) {
                        filterPanelIds = roles;
                    }
                } else {
                    filterPanelIds = [];
                }
            }

            let query = `SELECT p.id,p.panel_id,p.discharged_at
                FROM ipds p
                WHERE p.hospital_id = $1 AND p.is_active = true`;

            const queryParams: any[] = [hospitalId];

            if (filterPanelIds !== null) {
                query += ` AND p.panel_id = ANY($2)`;
                queryParams.push(filterPanelIds);
            }

            const patientRes = await pool.query(query, queryParams)

            const panelStats = patientRes.rows.reduce((acc, patient) => {
                if (!acc[patient.panel_id]) {
                    acc[patient.panel_id] = { total: 0, admitted: 0 };
                }
                acc[patient.panel_id].total += 1;
                if (!patient.discharged_at) {
                    acc[patient.panel_id].admitted += 1;
                }
                return acc;
            }, {});

            res.status(200).json(
                new apiResponse(200, panelStats, 'Successfully fetched hospital panels')
            )
        }
    )

    getHospitalUsers = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { hospitalId } = req.params
            const userId = req.user?.id
            const userRole = req.user?.role

            if (!hospitalId) throw new apiError(400, 'Hospital ID is required')

            // If simple hospital user, verification they belong to this hospital
            if (userRole === 'hospital') {
                const membership = await pool.query(
                    'SELECT 1 FROM hospital_users WHERE user_id = $1 AND hospital_id = $2',
                    [userId, hospitalId]
                )
                if (membership.rowCount === 0) {
                    throw new apiError(403, 'You are not a member of this hospital')
                }
            }

            const usersRes = await pool.query(
                `SELECT hu.user_id, u.username, u.first_name, u.last_name, u.email, u.phone, hu.role, u.is_active
                 FROM hospital_users hu
                 JOIN users u ON hu.user_id = u.id
                 WHERE hu.hospital_id = $1
                 ORDER BY u.first_name ASC`,
                [hospitalId]
            )

            res.status(200).json(
                new apiResponse(200, usersRes.rows, 'Successfully fetched hospital users')
            )
        }
    )

    // Get hospital info for the current hospital user
    getMyHospital = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const userId = req.user?.id
            if (!userId) throw new apiError(401, 'Unauthorized')

            const hospitalUserRes = await pool.query(
                `SELECT hu.hospital_id, hu.role, h.name, h.city, h.drive_folder_id, h.details
                 FROM hospital_users hu
                 JOIN hospitals h ON hu.hospital_id = h.id
                 WHERE hu.user_id = $1`,
                [userId]
            )

            if (hospitalUserRes.rowCount === 0) {
                throw new apiError(404, 'No hospital assignment found')
            }

            res.status(200).json(
                new apiResponse(200, hospitalUserRes.rows[0], 'Successfully fetched hospital info')
            )
        }
    )


    updateHospitalUserRole = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { hospitalId, userId } = req.params;
            const { role } = req.body;

            if (!hospitalId || !userId) {
                throw new apiError(400, "Hospital ID and User ID are required");
            }

            if (!role || !Array.isArray(role)) {
                throw new apiError(400, "Valid role array is required");
            }

            const updateRes = await pool.query(
                `UPDATE hospital_users 
                 SET role = $1 
                 WHERE hospital_id = $2 AND user_id = $3
                 RETURNING *`,
                [role, hospitalId, userId]
            );

            if (updateRes.rowCount === 0) {
                throw new apiError(404, "Hospital user not found");
            }

            // Fetch updated user details to return
            const userRes = await pool.query(
                `SELECT hu.user_id, u.username, u.first_name, u.last_name, u.email, u.phone, hu.role, u.is_active
                 FROM hospital_users hu
                 JOIN users u ON hu.user_id = u.id
                 WHERE hu.hospital_id = $1 AND hu.user_id = $2`,
                [hospitalId, userId]
            );

            res.status(200).json(
                new apiResponse(200, userRes.rows[0], "User role updated successfully")
            );
        }
    )

    getHospitalById = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { hospitalId } = req.params;
            if (!hospitalId) throw new apiError(400, "Hospital ID is required");

            const hospitalRes = await pool.query(
                `SELECT id, name, city, drive_folder_id, details 
                 FROM hospitals 
                 WHERE id = $1`,
                [hospitalId]
            );

            if (hospitalRes.rowCount === 0) {
                throw new apiError(404, "Hospital not found");
            }

            res.status(200).json(
                new apiResponse(200, hospitalRes.rows[0], "Successfully fetched hospital")
            );
        }
    )

    updateHospital = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const adminId = req.user?.id
            if (!adminId) throw new apiError(401, 'Unauthorized')

            const { hospitalId } = req.params;
            let { name, city, details } = req.body;

            if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

            const queryParts = [];
            const values = [];
            let idx = 1;

            if (name !== undefined) {
                queryParts.push(`name = $${idx++}`);
                values.push(name);
            }
            if (city !== undefined) {
                queryParts.push(`city = $${idx++}`);
                values.push(city);
            }
            if (details !== undefined) {
                try {
                    // Sanitize details via strictly checking allowed keys and stripping anomalies
                    const parsedDetails = typeof details === 'string' ? JSON.parse(details) : details;
                    const sanitizedDetails = hospitalDetailsSchema.parse(parsedDetails);
                    queryParts.push(`details = $${idx++}`);
                    values.push(JSON.stringify(sanitizedDetails));
                } catch (error) {
                    throw new apiError(400, 'Invalid details payload structure');
                }
            }

            if (queryParts.length === 0) {
                throw new apiError(400, 'No fields provided for update');
            }

            values.push(hospitalId);
            const query = `UPDATE hospitals SET ${queryParts.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${idx} RETURNING id, name, city, details, drive_folder_id, updated_at`;

            const hospitalRes = await pool.query(query, values);

            if ((hospitalRes.rowCount ?? 0) === 0) {
                throw new apiError(404, 'Hospital not found');
            }

            res.status(200).json(
                new apiResponse(
                    200,
                    hospitalRes.rows[0],
                    'Successfully updated hospital'
                )
            );
        }
    )
}

export default hospitalController
