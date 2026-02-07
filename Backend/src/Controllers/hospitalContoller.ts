import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import apiResponse from '../Utils/apiResponse.util.js'
import driveHandler from '../Services/driveUploader.service.js'
import fileName from '../Utils/fileName.util.js'

const DriveHandler = new driveHandler()
const FileName = new fileName()

const rootId = (process.env.GOOGLE_DRIVE_ROOT_ID || process.env.PARENT) as string

class hospitalController {
    addHospital = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const adminId = req.user?.id
            if (!adminId) throw new apiError(401, 'Unauthorized')

            const { name, city, driveFolderId } = req.body

            if (!name || !city) throw new apiError(400, 'Provide name and city')

            let finalDriveFolderId = driveFolderId;

            if (!finalDriveFolderId) {
                const folder = await DriveHandler.createFolder(
                    FileName.folderName(name),
                    rootId
                )
                if (!folder.fileId) throw new apiError(500, "Couldn't create drive folder");
                finalDriveFolderId = folder.fileId;
            }

            const hospitalRes = await pool.query(
                'insert into hospitals (name,city,drive_folder_id) values ($1,$2,$3) returning id, name, city, drive_folder_id, created_at',
                [name, city, finalDriveFolderId]
            )

            if (hospitalRes.rowCount == 0)
                throw new apiError(
                    500,
                    'Somethng went wront while creating the hospital please try again'
                )

            res.status(201).json(
                new apiResponse(
                    201,
                    hospitalRes.rows[0],
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
                'Select id,name,city,drive_folder_id from hospitals'
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
                'select id,name,city,drive_folder_id from hospitals where id = ANY($1)',
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
                // Panel already linked, just add access for hospital user if needed
                if (userRole === 'hospital') {
                    await pool.query(
                        `UPDATE hospital_users 
                         SET role = array_append(role, $1) 
                         WHERE user_id = $2 AND hospital_id = $3 AND NOT ($1 = ANY(role))`,
                        [panelId, userId, resolvedHospitalId]
                    )
                }
                res.status(200).json(
                    new apiResponse(200, existingLink.rows[0], 'Panel already linked. Access granted.')
                )
                return
            }

            const folder = await DriveHandler.createFolder(
                FileName.folderName(panelRes.rows[0].name),
                hospitalRes.rows[0].drive_folder_id
            )
            const panelLink = await pool.query(
                'insert into hospital_panels (hospital_id,panel_id,whatsapp_group_id,sheet_id,sheet_name,drive_folder_id,contact) values ($1,$2,$3,$4,$5,$6,$7) returning *',
                [
                    resolvedHospitalId,
                    panelId,
                    whatsAppGroupId,
                    sheetId,
                    sheetName,
                    folder?.fileId,
                    contact,
                ]
            )
            if (panelLink.rowCount == 0) throw new apiError(500, 'Something went wrong while linking panel')

            // For hospital users, automatically grant access to this panel
            if (userRole === 'hospital') {
                await pool.query(
                    `UPDATE hospital_users 
                     SET role = array_append(role, $1) 
                     WHERE user_id = $2 AND hospital_id = $3 AND NOT ($1 = ANY(role))`,
                    [panelId, userId, resolvedHospitalId]
                )
            }

            res.status(201).json(new apiResponse(201, panelLink.rows[0], 'Panel linked successfully'))
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
                        count(i.id) as total_count
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
                hp.id, hp.hospital_id, hp.panel_id, p.name as panel_name, hp.whatsapp_group_id, hp.sheet_id, hp.sheet_name, hp.drive_folder_id, hp.contact, count(i.id) as total_count
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
                `SELECT hu.hospital_id, hu.role, h.name, h.city, h.drive_folder_id
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
}

export default hospitalController
