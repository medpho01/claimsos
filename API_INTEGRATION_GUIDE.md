# Attribute Definitions Management API - Integration Guide

**Version:** 1.0.0  
**Last Updated:** April 21, 2026  
**API Base URL:** `http://localhost:8000/api/v1` (development)

---

## Table of Contents

1. [Authentication](#authentication)
2. [Hospital Attribute Definitions API](#hospital-attribute-definitions-api)
3. [Panel Attribute Definitions API](#panel-attribute-definitions-api)
4. [Error Handling](#error-handling)
5. [Data Structures](#data-structures)
6. [Code Examples](#code-examples)
7. [Testing Checklist](#testing-checklist)

---

## Authentication

### Overview
All endpoints require JWT authentication via Bearer token. The token must be sent in the `Authorization` header for every request.

### Getting a Token

**Endpoint:** `POST /api/v1/auth/login`

**Request Body:**
```json
{
  "userName": "testuser",
  "passWord": "test123"
}
```

**Response (200 OK):**
```json
{
  "statusCode": 200,
  "success": true,
  "message": "Login successful",
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "62a65fe7-de01-4c50-81cc-555d3458317e",
    "user": {
      "id": "df2c60d6-d634-4697-a997-e9fd0f3b9960",
      "username": "testuser",
      "email": "test@test.com",
      "role": "superadmin",
      "first_name": "Test",
      "last_name": "User"
    }
  }
}
```

### Using the Token

Include the token in all subsequent requests:

```bash
curl -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
     http://localhost:8000/api/v1/admin/attribute-definitions
```

### Token Expiry
- **Access Token Expiry:** 1 hour
- **Refresh Token Expiry:** 7 days

### Authorization Requirements

| Feature | Required Role | Min Permission Level |
|---------|---------------|---------------------|
| View Definitions (metadata) | Any authenticated user | `checkAuth` |
| View All Definitions | Any authenticated user | `checkAuth` |
| Create/Update/Delete | Superadmin | `checkSuperAdmin` |
| Activate/Deactivate | Superadmin | `checkSuperAdmin` |

---

## Hospital Attribute Definitions API

Hospital attributes represent standardized hospital characteristics (accreditations, beds, equipment, staffing, etc.).

### 1. List All Hospital Attribute Definitions

**Endpoint:** `GET /admin/attribute-definitions`

**Query Parameters:**
| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| `category` | string | Filter by category (e.g., `service`, `beds`) | No |
| `data_type` | string | Filter by data type (`boolean`, `integer`, `document`) | No |
| `is_active` | boolean | Filter by active status (`true` or `false`) | No |
| `search` | string | Search in key, label, or description | No |

**Example Request:**
```bash
GET /admin/attribute-definitions?category=service&is_active=true
Authorization: Bearer YOUR_TOKEN
```

**Example Response (200 OK):**
```json
{
  "statusCode": 200,
  "success": true,
  "message": "Retrieved 15 attribute definitions",
  "data": [
    {
      "key": "service.nephrology",
      "category": "service",
      "label": "Nephrology Department",
      "description": "Neprology services available",
      "data_type": "boolean",
      "unit": null,
      "requires_document": false,
      "has_expiry": false,
      "expected_issuing_authority": null,
      "can_verify_by_image": false,
      "image_guidance": null,
      "is_mandatory_basic": false,
      "is_mandatory_empanelment": false,
      "sort_order": 50,
      "is_active": true,
      "created_at": "2026-04-21T08:00:00.000Z",
      "updated_at": "2026-04-21T08:00:00.000Z"
    }
    // ... more definitions
  ]
}
```

---

### 2. Get Single Hospital Attribute Definition

**Endpoint:** `GET /admin/attribute-definitions/:key`

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `key` | string | Unique attribute key (e.g., `service.nephrology`) |

**Example Request:**
```bash
GET /admin/attribute-definitions/service.nephrology
Authorization: Bearer YOUR_TOKEN
```

**Example Response (200 OK):**
```json
{
  "statusCode": 200,
  "success": true,
  "message": "Attribute definition retrieved",
  "data": {
    "key": "service.nephrology",
    "category": "service",
    "label": "Nephrology Department",
    "description": "Nephrology services available",
    "data_type": "boolean",
    "unit": null,
    "requires_document": false,
    "has_expiry": false,
    "expected_issuing_authority": null,
    "can_verify_by_image": false,
    "image_guidance": null,
    "is_mandatory_basic": false,
    "is_mandatory_empanelment": false,
    "sort_order": 50,
    "is_active": true,
    "created_at": "2026-04-21T08:00:00.000Z",
    "updated_at": "2026-04-21T08:00:00.000Z"
  }
}
```

**Error Response (404 Not Found):**
```json
{
  "statusCode": 404,
  "success": false,
  "message": "Attribute definition not found",
  "data": null
}
```

---

### 3. Create Hospital Attribute Definition

**Endpoint:** `POST /admin/attribute-definitions`

**Request Body:**
```json
{
  "key": "staffing.dentists",
  "category": "staffing",
  "label": "Dentists Count",
  "description": "Total number of dentists on staff",
  "data_type": "integer",
  "unit": "count",
  "requires_document": false,
  "has_expiry": false,
  "expected_issuing_authority": null,
  "can_verify_by_image": false,
  "image_guidance": null,
  "is_mandatory_basic": false,
  "is_mandatory_empanelment": false,
  "sort_order": 110,
  "is_active": true
}
```

**Field Descriptions:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | Yes | Unique identifier. Format: `category.subcategory.name` (lowercase, dots only). Regex: `^[a-z0-9]+\.[a-z0-9]+(\.[a-z0-9]+)?$` |
| `category` | string | Yes | Category grouping (e.g., `service`, `beds`, `equipment`, `staffing`, `accreditation`) |
| `label` | string | Yes | Human-readable name |
| `description` | string | No | Detailed description of the attribute |
| `data_type` | string | Yes | One of: `boolean`, `integer`, `text`, `date`, `document` |
| `unit` | string | No | Unit of measurement (e.g., `count`, `beds`, `hours`) |
| `requires_document` | boolean | No | Whether a document is required (default: false) |
| `has_expiry` | boolean | No | Whether the document expires (default: false) |
| `expected_issuing_authority` | string | No | Authority that issues the document |
| `can_verify_by_image` | boolean | No | Whether it can be verified by image (default: false) |
| `image_guidance` | string | No | Guidance text for image upload |
| `is_mandatory_basic` | boolean | No | Required for basic hospital info (default: false) |
| `is_mandatory_empanelment` | boolean | No | Required for empanelment (default: false) |
| `sort_order` | number | No | Display sort order (default: 999) |
| `is_active` | boolean | No | Active status (default: true) |

**Example Response (201 Created):**
```json
{
  "statusCode": 201,
  "success": true,
  "message": "Attribute definition created successfully",
  "data": {
    "key": "staffing.dentists",
    "category": "staffing",
    "label": "Dentists Count",
    "description": "Total number of dentists on staff",
    "data_type": "integer",
    "unit": "count",
    "requires_document": false,
    "has_expiry": false,
    "expected_issuing_authority": null,
    "can_verify_by_image": false,
    "image_guidance": null,
    "is_mandatory_basic": false,
    "is_mandatory_empanelment": false,
    "sort_order": 110,
    "is_active": true,
    "created_at": "2026-04-21T09:30:00.000Z",
    "updated_at": "2026-04-21T09:30:00.000Z"
  }
}
```

**Error Response - Duplicate Key (409 Conflict):**
```json
{
  "statusCode": 409,
  "success": false,
  "message": "Attribute key 'staffing.dentists' already exists",
  "data": null
}
```

**Error Response - Invalid Key Format (400 Bad Request):**
```json
{
  "statusCode": 400,
  "success": false,
  "message": "Invalid key format. Use format: category.subcategory or category.subcategory.name (lowercase with dots)",
  "data": null
}
```

---

### 4. Update Hospital Attribute Definition

**Endpoint:** `PUT /admin/attribute-definitions/:key`

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `key` | string | The key of the definition to update |

**Request Body (all fields optional):**
```json
{
  "label": "Updated Label",
  "description": "Updated description",
  "category": "service",
  "unit": "count",
  "sort_order": 120,
  "is_active": true
}
```

**Notes:**
- The `key` field cannot be updated (use DELETE + CREATE to rename)
- Only specified fields are updated
- Timestamps (`created_at`, `updated_at`) are managed automatically

**Example Response (200 OK):**
```json
{
  "statusCode": 200,
  "success": true,
  "message": "Attribute definition updated successfully",
  "data": {
    "key": "staffing.dentists",
    "category": "service",
    "label": "Updated Label",
    "description": "Updated description",
    "data_type": "integer",
    "unit": "count",
    "is_mandatory_basic": false,
    "is_mandatory_empanelment": false,
    "sort_order": 120,
    "is_active": true,
    "created_at": "2026-04-21T09:30:00.000Z",
    "updated_at": "2026-04-21T10:00:00.000Z"
  }
}
```

---

### 5. Delete Hospital Attribute Definition

**Endpoint:** `DELETE /admin/attribute-definitions/:key`

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `key` | string | The key of the definition to delete |

**Example Request:**
```bash
DELETE /admin/attribute-definitions/staffing.dentists
Authorization: Bearer YOUR_TOKEN
```

**Example Response (200 OK):**
```json
{
  "statusCode": 200,
  "success": true,
  "message": "Attribute definition deleted successfully",
  "data": {
    "key": "staffing.dentists",
    "category": "staffing",
    "label": "Dentists Count"
  }
}
```

**Error Response - Definition Has Associated Data (422 Unprocessable Entity):**
```json
{
  "statusCode": 422,
  "success": false,
  "message": "Cannot delete attribute definition. It has 5 associated hospital attributes. Deactivate instead using activate/deactivate endpoint.",
  "data": null
}
```

**Recommendation:** Instead of deleting, use the deactivate endpoint to soft-delete without losing audit trail.

---

### 6. Activate Hospital Attribute Definition

**Endpoint:** `PATCH /admin/attribute-definitions/:key/activate`

**Example Request:**
```bash
PATCH /admin/attribute-definitions/staffing.dentists/activate
Authorization: Bearer YOUR_TOKEN
```

**Example Response (200 OK):**
```json
{
  "statusCode": 200,
  "success": true,
  "message": "Attribute definition activated successfully",
  "data": {
    "key": "staffing.dentists",
    "is_active": true,
    "updated_at": "2026-04-21T10:15:00.000Z"
  }
}
```

---

### 7. Deactivate Hospital Attribute Definition

**Endpoint:** `PATCH /admin/attribute-definitions/:key/deactivate`

**Example Request:**
```bash
PATCH /admin/attribute-definitions/staffing.dentists/deactivate
Authorization: Bearer YOUR_TOKEN
```

**Example Response (200 OK):**
```json
{
  "statusCode": 200,
  "success": true,
  "message": "Attribute definition deactivated successfully",
  "data": {
    "key": "staffing.dentists",
    "is_active": false,
    "updated_at": "2026-04-21T10:20:00.000Z"
  }
}
```

---

### 8. Validate Hospital Attribute Key Uniqueness

**Endpoint:** `POST /admin/attribute-definitions/validate-key`

**Request Body:**
```json
{
  "key": "service.new.specialty",
  "excludeKey": "service.existing.key"
}
```

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `key` | string | Key to validate |
| `excludeKey` | string | Optional: exclude this key from uniqueness check (for edit scenarios) |

**Example Response - Unique Key (200 OK):**
```json
{
  "statusCode": 200,
  "success": true,
  "message": "Key validation completed",
  "data": {
    "isUnique": true,
    "message": "Key is unique"
  }
}
```

**Example Response - Duplicate Key (200 OK):**
```json
{
  "statusCode": 200,
  "success": true,
  "message": "Key validation completed",
  "data": {
    "isUnique": false,
    "message": "Key already exists"
  }
}
```

---

### 9. Get Hospital Attribute Definition Categories

**Endpoint:** `GET /admin/attribute-definitions/metadata/categories`

**Example Request:**
```bash
GET /admin/attribute-definitions/metadata/categories
Authorization: Bearer YOUR_TOKEN
```

**Example Response (200 OK):**
```json
{
  "statusCode": 200,
  "success": true,
  "message": "Retrieved 9 categories",
  "data": [
    "accreditation",
    "beds",
    "compliance_cert",
    "compliance_policy",
    "equipment",
    "infrastructure",
    "lab",
    "ot",
    "service"
  ]
}
```

---

### 10. Get Hospital Attribute Definition Data Types

**Endpoint:** `GET /admin/attribute-definitions/metadata/data-types`

**Example Request:**
```bash
GET /admin/attribute-definitions/metadata/data-types
Authorization: Bearer YOUR_TOKEN
```

**Example Response (200 OK):**
```json
{
  "statusCode": 200,
  "success": true,
  "message": "Retrieved 3 data types",
  "data": [
    "boolean",
    "document",
    "integer"
  ]
}
```

---

## Panel Attribute Definitions API

Panel attributes represent standardized attributes for vendor/empanelment panels (contact info, credentials, documents, etc.).

### 1. List All Panel Attribute Definitions

**Endpoint:** `GET /admin/panel-attributes/definitions`

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `category` | string | Filter by category | No |

**Example Request:**
```bash
GET /admin/panel-attributes/definitions?category=contact
Authorization: Bearer YOUR_TOKEN
```

**Example Response (200 OK):**
```json
{
  "success": true,
  "message": "Panel attribute definitions fetched successfully",
  "data": [
    {
      "id": "b2e942af-5e67-4966-bbae-6517c4562f26",
      "key": "hospital_primary_contact_name",
      "category": "contact",
      "label": "Primary Contact Name",
      "description": "Name of the primary contact person",
      "data_type": "text",
      "options": null,
      "validation_regex": null,
      "validation_min_length": null,
      "validation_max_length": null,
      "is_required": true,
      "is_unique": false,
      "default_value": null,
      "sort_order": 10,
      "is_active": true,
      "created_at": "2026-04-20T12:00:00.000Z",
      "updated_at": "2026-04-20T12:00:00.000Z"
    }
    // ... more definitions
  ]
}
```

---

### 2. Get Panel Attribute Definitions Grouped by Category

**Endpoint:** `GET /admin/panel-attributes/definitions/by-category`

**Example Request:**
```bash
GET /admin/panel-attributes/definitions/by-category
Authorization: Bearer YOUR_TOKEN
```

**Example Response (200 OK):**
```json
{
  "success": true,
  "message": "Panel attribute definitions by category fetched successfully",
  "data": {
    "portal": [
      {
        "id": "uuid-1",
        "key": "portal_username",
        "label": "Portal Username",
        "data_type": "text"
      }
    ],
    "credential": [
      {
        "id": "uuid-2",
        "key": "gst_number",
        "label": "GST Number",
        "data_type": "text"
      }
    ],
    "contact": [
      {
        "id": "b2e942af-5e67-4966-bbae-6517c4562f26",
        "key": "hospital_primary_contact_name",
        "label": "Primary Contact Name",
        "data_type": "text"
      }
    ],
    "document": [],
    "operational": []
  }
}
```

---

### 3. Get Single Panel Attribute Definition

**Endpoint:** `GET /admin/panel-attributes/definitions/:id`

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | uuid | The ID of the definition to retrieve |

**Example Request:**
```bash
GET /admin/panel-attributes/definitions/b2e942af-5e67-4966-bbae-6517c4562f26
Authorization: Bearer YOUR_TOKEN
```

**Example Response (200 OK):**
```json
{
  "success": true,
  "message": "Panel attribute definition fetched successfully",
  "data": {
    "id": "b2e942af-5e67-4966-bbae-6517c4562f26",
    "key": "hospital_primary_contact_name",
    "category": "contact",
    "label": "Primary Contact Name",
    "description": "Name of the primary contact person",
    "data_type": "text",
    "options": null,
    "validation_regex": null,
    "validation_min_length": null,
    "validation_max_length": null,
    "is_required": true,
    "is_unique": false,
    "default_value": null,
    "sort_order": 10,
    "is_active": true,
    "created_at": "2026-04-20T12:00:00.000Z",
    "updated_at": "2026-04-20T12:00:00.000Z"
  }
}
```

---

### 4. Create Panel Attribute Definition

**Endpoint:** `POST /admin/panel-attributes/definitions`

**Request Body:**
```json
{
  "key": "vendor_gst_number",
  "category": "credential",
  "label": "GST Number",
  "description": "Government Service Tax Identification Number",
  "data_type": "text",
  "options": null,
  "validation_regex": "^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{1}Z[0-9]{1}$",
  "validation_min_length": 15,
  "validation_max_length": 15,
  "is_required": true,
  "is_unique": true,
  "default_value": null,
  "sort_order": 20,
  "is_active": true
}
```

**Field Descriptions:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | Yes | Unique identifier (lowercase with underscores). Regex: `^[a-z0-9_]+$` |
| `category` | string | Yes | One of: `portal`, `credential`, `contact`, `document`, `operational` |
| `label` | string | Yes | Human-readable name |
| `description` | string | No | Detailed description |
| `data_type` | string | Yes | One of: `text`, `email`, `phone`, `url`, `date`, `boolean`, `single_select`, `multi_select`, `file`, `integer`, `decimal`, `encrypted_text` |
| `options` | JSON array | No | For select types: `[{"key": "val1", "label": "Value 1"}, ...]` |
| `validation_regex` | string | No | Regex pattern for validation |
| `validation_min_length` | number | No | Minimum string length |
| `validation_max_length` | number | No | Maximum string length |
| `is_required` | boolean | No | Field is mandatory (default: false) |
| `is_unique` | boolean | No | Value must be unique (default: false) |
| `default_value` | string | No | Default value if not provided |
| `sort_order` | number | No | Display order (default: 999) |
| `is_active` | boolean | No | Active status (default: true) |

**Example Response - Text Attribute (201 Created):**
```json
{
  "success": true,
  "message": "Panel attribute definition created successfully",
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "key": "vendor_gst_number",
    "category": "credential",
    "label": "GST Number",
    "description": "Government Service Tax Identification Number",
    "data_type": "text",
    "options": null,
    "validation_regex": "^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{1}Z[0-9]{1}$",
    "validation_min_length": 15,
    "validation_max_length": 15,
    "is_required": true,
    "is_unique": true,
    "default_value": null,
    "sort_order": 20,
    "is_active": true,
    "created_at": "2026-04-21T09:45:00.000Z",
    "updated_at": "2026-04-21T09:45:00.000Z"
  }
}
```

**Example Request - Select Attribute:**
```json
{
  "key": "vendor_type",
  "category": "operational",
  "label": "Vendor Type",
  "data_type": "single_select",
  "options": [
    {"key": "vendor", "label": "Vendor"},
    {"key": "supplier", "label": "Supplier"},
    {"key": "distributor", "label": "Distributor"}
  ],
  "is_required": true,
  "sort_order": 5
}
```

---

### 5. Update Panel Attribute Definition

**Endpoint:** `PUT /admin/panel-attributes/definitions/:id`

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | uuid | The ID of the definition to update |

**Request Body (all fields optional):**
```json
{
  "label": "Updated GST Number",
  "description": "Updated description",
  "validation_regex": "^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{1}Z[0-9]{1}$",
  "is_required": false,
  "sort_order": 25
}
```

**Example Response (200 OK):**
```json
{
  "success": true,
  "message": "Panel attribute definition updated successfully",
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "key": "vendor_gst_number",
    "label": "Updated GST Number",
    "description": "Updated description",
    "data_type": "text",
    "is_required": false,
    "sort_order": 25,
    "is_active": true,
    "updated_at": "2026-04-21T10:00:00.000Z"
  }
}
```

---

### 6. Delete Panel Attribute Definition

**Endpoint:** `DELETE /admin/panel-attributes/definitions/:id`

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | uuid | The ID of the definition to delete |

**Example Request:**
```bash
DELETE /admin/panel-attributes/definitions/a1b2c3d4-e5f6-7890-abcd-ef1234567890
Authorization: Bearer YOUR_TOKEN
```

**Example Response (200 OK):**
```json
{
  "success": true,
  "message": "Panel attribute definition deleted successfully",
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "key": "vendor_gst_number"
  }
}
```

---

### 7. Activate Panel Attribute Definition

**Endpoint:** `PATCH /admin/panel-attributes/definitions/:id/activate`

**Example Request:**
```bash
PATCH /admin/panel-attributes/definitions/a1b2c3d4-e5f6-7890-abcd-ef1234567890/activate
Authorization: Bearer YOUR_TOKEN
```

**Example Response (200 OK):**
```json
{
  "success": true,
  "message": "Panel attribute definition activated successfully",
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "is_active": true
  }
}
```

---

### 8. Deactivate Panel Attribute Definition

**Endpoint:** `PATCH /admin/panel-attributes/definitions/:id/deactivate`

**Example Request:**
```bash
PATCH /admin/panel-attributes/definitions/a1b2c3d4-e5f6-7890-abcd-ef1234567890/deactivate
Authorization: Bearer YOUR_TOKEN
```

**Example Response (200 OK):**
```json
{
  "success": true,
  "message": "Panel attribute definition deactivated successfully",
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "is_active": false
  }
}
```

---

### 9. Validate Panel Attribute Key Uniqueness

**Endpoint:** `POST /admin/panel-attributes/definitions/validate-key`

**Request Body:**
```json
{
  "key": "vendor_pan_number",
  "excludeId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

**Example Response - Unique (200 OK):**
```json
{
  "success": true,
  "message": "Key validation completed",
  "data": {
    "isUnique": true,
    "message": "Key is unique"
  }
}
```

**Example Response - Duplicate (200 OK):**
```json
{
  "success": true,
  "message": "Key validation completed",
  "data": {
    "isUnique": false,
    "message": "Key already exists"
  }
}
```

---

## Error Handling

### HTTP Status Codes

| Status | Meaning | Example Scenario |
|--------|---------|-----------------|
| 200 | OK | Successful GET, PUT, PATCH, DELETE |
| 201 | Created | Successful POST (creation) |
| 400 | Bad Request | Invalid request format, missing required fields, invalid key format |
| 401 | Unauthorized | Missing or invalid authentication token |
| 403 | Forbidden | User lacks required permissions (not superadmin) |
| 404 | Not Found | Definition doesn't exist |
| 409 | Conflict | Key already exists (duplicate) |
| 422 | Unprocessable Entity | Cannot delete definition with associated data |
| 500 | Internal Server Error | Database or server error |

### Error Response Format

All errors follow this format:

```json
{
  "statusCode": 400,
  "success": false,
  "message": "Error message describing what went wrong",
  "data": null
}
```

### Common Error Messages

**Invalid Key Format (Hospital Attributes)**
```json
{
  "statusCode": 400,
  "success": false,
  "message": "Invalid key format. Use format: category.subcategory or category.subcategory.name (lowercase with dots)"
}
```

**Missing Authentication**
```json
{
  "statusCode": 401,
  "success": false,
  "message": "Unauthorized request. Access token missing."
}
```

**Insufficient Permissions**
```json
{
  "statusCode": 403,
  "success": false,
  "message": "Access denied. Superadmin role required."
}
```

**Duplicate Key**
```json
{
  "statusCode": 409,
  "success": false,
  "message": "Attribute key 'service.nephrology' already exists"
}
```

**Definition Has Associated Data**
```json
{
  "statusCode": 422,
  "success": false,
  "message": "Cannot delete attribute definition. It has 5 associated hospital attributes. Deactivate instead using activate/deactivate endpoint."
}
```

---

## Data Structures

### Hospital Attribute Definition Object

```typescript
interface HospitalAttributeDefinition {
  key: string;                              // Unique identifier
  category: string;                         // Category name
  label: string;                            // Display label
  description?: string;                     // Description
  data_type: 'boolean' | 'integer' | 'text' | 'date' | 'document';
  unit?: string;                            // Unit of measurement
  requires_document?: boolean;               // If document is required
  has_expiry?: boolean;                     // If document expires
  expected_issuing_authority?: string;      // Authority issuing the document
  can_verify_by_image?: boolean;            // If verifiable by image
  image_guidance?: string;                  // Guidance for image upload
  is_mandatory_basic?: boolean;             // Required for basic info
  is_mandatory_empanelment?: boolean;       // Required for empanelment
  sort_order?: number;                      // Display order
  is_active: boolean;                       // Active status
  created_at: string;                       // ISO timestamp
  updated_at: string;                       // ISO timestamp
}
```

### Panel Attribute Definition Object

```typescript
interface PanelAttributeDefinition {
  id: string;                               // UUID
  key: string;                              // Unique identifier
  category: 'portal' | 'credential' | 'contact' | 'document' | 'operational';
  label: string;                            // Display label
  description?: string;                     // Description
  data_type: string;                        // Type: text, email, phone, url, date, boolean, single_select, multi_select, file, integer, decimal, encrypted_text
  options?: Array<{ key: string, label: string }>;  // For select types
  validation_regex?: string;                // Regex validation pattern
  validation_min_length?: number;           // Min string length
  validation_max_length?: number;           // Max string length
  is_required: boolean;                     // Field is mandatory
  is_unique: boolean;                       // Value must be unique
  default_value?: string;                   // Default value
  sort_order?: number;                      // Display order
  is_active: boolean;                       // Active status
  created_at: string;                       // ISO timestamp
  updated_at: string;                       // ISO timestamp
}
```

---

## Code Examples

### JavaScript/TypeScript - Using Fetch API

```typescript
// Authentication
const login = async () => {
  const response = await fetch('http://localhost:8000/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userName: 'testuser',
      passWord: 'test123'
    })
  });
  
  const data = await response.json();
  const token = data.data.accessToken;
  return token;
};

// Get all hospital attribute definitions
const getHospitalAttributes = async (token: string) => {
  const response = await fetch(
    'http://localhost:8000/api/v1/admin/attribute-definitions',
    {
      headers: { 'Authorization': `Bearer ${token}` }
    }
  );
  
  const data = await response.json();
  return data.data;
};

// Create hospital attribute
const createHospitalAttribute = async (token: string, payload: any) => {
  const response = await fetch(
    'http://localhost:8000/api/v1/admin/attribute-definitions',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message);
  }
  
  const data = await response.json();
  return data.data;
};

// Update hospital attribute
const updateHospitalAttribute = async (
  token: string,
  key: string,
  payload: any
) => {
  const response = await fetch(
    `http://localhost:8000/api/v1/admin/attribute-definitions/${key}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );
  
  const data = await response.json();
  return data.data;
};

// Validate key uniqueness
const validateKey = async (token: string, key: string) => {
  const response = await fetch(
    'http://localhost:8000/api/v1/admin/attribute-definitions/validate-key',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ key })
    }
  );
  
  const data = await response.json();
  return data.data;
};

// Get panel attribute definitions by category
const getPanelAttributesByCategory = async (token: string) => {
  const response = await fetch(
    'http://localhost:8000/api/v1/admin/panel-attributes/definitions/by-category',
    {
      headers: { 'Authorization': `Bearer ${token}` }
    }
  );
  
  const data = await response.json();
  return data.data;
};

// Create panel attribute with select options
const createPanelAttribute = async (token: string, payload: any) => {
  const response = await fetch(
    'http://localhost:8000/api/v1/admin/panel-attributes/definitions',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );
  
  const data = await response.json();
  return data.data;
};
```

### React Hook Example

```typescript
import { useState, useCallback } from 'react';

export const useAttributeDefinitions = (token: string) => {
  const [definitions, setDefinitions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDefinitions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        'http://localhost:8000/api/v1/admin/attribute-definitions',
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      
      if (!response.ok) throw new Error('Failed to fetch');
      
      const data = await response.json();
      setDefinitions(data.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [token]);

  const createDefinition = useCallback(
    async (payload: any) => {
      try {
        const response = await fetch(
          'http://localhost:8000/api/v1/admin/attribute-definitions',
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          }
        );
        
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.message);
        }
        
        const data = await response.json();
        setDefinitions(prev => [...prev, data.data]);
        return data.data;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setError(message);
        throw err;
      }
    },
    [token]
  );

  return { definitions, loading, error, fetchDefinitions, createDefinition };
};
```

---

## Testing Checklist

### Hospital Attribute Definitions

- [ ] **List All** - GET `/admin/attribute-definitions` returns 200 with definitions array
- [ ] **List with Filters** - GET `/admin/attribute-definitions?category=service` returns only service attributes
- [ ] **List Search** - GET `/admin/attribute-definitions?search=nephrology` finds matching definitions
- [ ] **Get Single** - GET `/admin/attribute-definitions/service.nephrology` returns correct definition
- [ ] **Get Single 404** - GET `/admin/attribute-definitions/invalid.key` returns 404
- [ ] **Create Valid** - POST with all required fields returns 201 with created definition
- [ ] **Create Invalid Key Format** - POST with invalid key format returns 400
- [ ] **Create Duplicate Key** - POST with existing key returns 409
- [ ] **Update** - PUT with partial data returns 200 with updated definition
- [ ] **Update Try Key** - PUT with key field in body returns 400
- [ ] **Delete** - DELETE returns 200 with deleted definition
- [ ] **Delete with Associated Data** - DELETE returns 422 with helpful message
- [ ] **Deactivate** - PATCH `/deactivate` returns 200 with is_active: false
- [ ] **Activate** - PATCH `/activate` returns 200 with is_active: true
- [ ] **Validate Unique Key** - POST `/validate-key` with new key returns isUnique: true
- [ ] **Validate Duplicate Key** - POST `/validate-key` with existing key returns isUnique: false
- [ ] **Get Categories** - GET `/metadata/categories` returns array of category strings
- [ ] **Get Data Types** - GET `/metadata/data-types` returns array of type strings
- [ ] **Missing Auth** - Requests without token return 401
- [ ] **Non-Superadmin Create** - Non-superadmin user cannot create/update/delete

### Panel Attribute Definitions

- [ ] **List All** - GET `/admin/panel-attributes/definitions` returns 200 with array
- [ ] **List by Category** - GET `/admin/panel-attributes/definitions/by-category` returns grouped object
- [ ] **Get Single** - GET `/admin/panel-attributes/definitions/:id` returns definition
- [ ] **Create Text Attribute** - POST creates text attribute successfully
- [ ] **Create Select Attribute** - POST with options creates select attribute
- [ ] **Create with Validation** - POST with regex/min-max returns 201
- [ ] **Update** - PUT updates definition fields
- [ ] **Delete** - DELETE removes definition
- [ ] **Deactivate** - PATCH `/deactivate` sets is_active: false
- [ ] **Activate** - PATCH `/activate` sets is_active: true
- [ ] **Validate Unique Key** - POST `/validate-key` validates key uniqueness
- [ ] **Missing Auth** - Requests without token return 401

---

## Additional Notes

### Best Practices

1. **Always validate keys client-side** before submitting to avoid 409 errors
2. **Use pagination carefully** - implement pagination for large lists (future enhancement)
3. **Cache metadata** - Categories and data types don't change often
4. **Soft delete pattern** - Use deactivate instead of delete to preserve audit trail
5. **Handle rate limiting** - Implement exponential backoff for retries
6. **Validate file uploads** - Implement client-side validation before upload
7. **Monitor token expiry** - Refresh tokens before expiry to avoid 401 errors

### Future Enhancements

- [ ] Pagination support (limit, offset)
- [ ] Bulk operations (create/update multiple)
- [ ] Export/import definitions as JSON
- [ ] Audit trail with user tracking
- [ ] Branching/versioning of definitions
- [ ] Conditional field dependencies
- [ ] Template library for common attribute sets
- [ ] API rate limiting
- [ ] Caching optimization

---

## Support & Troubleshooting

### Common Issues

**"Cannot delete definition" error (422)**
- Solution: Use the deactivate endpoint instead of delete to preserve associated data

**"Key already exists" error (409)**
- Solution: Call the validate-key endpoint before submitting to provide user feedback

**"Invalid key format" error (400)**
- Hospital attributes: Must follow `category.subcategory[.name]` pattern with lowercase and dots
- Panel attributes: Must use lowercase and underscores only

**Unauthorized error (401)**
- Ensure token is fresh (max 1 hour old)
- Check that Authorization header format is correct: `Bearer TOKEN`
- Verify user has superadmin role for write operations

For more information or issues, contact the backend team or review the code in:
- `/Backend/src/Services/attributeDefinition.service.ts`
- `/Backend/src/Services/panelAttributeDefinition.service.ts`
