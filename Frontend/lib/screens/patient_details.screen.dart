import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../utils/toast_utils.dart';
import 'gallery.screen.dart';
import 'patient_form.screen.dart';
import 'view_photos.screen.dart';
import 'discharge_conservative_doc.screen.dart';
import 'discharge_surgical.screen.dart';

class PatientDetailsScreen extends StatefulWidget {
  final Map<String, dynamic> patient;

  const PatientDetailsScreen({required this.patient, super.key});

  @override
  State<PatientDetailsScreen> createState() => _PatientDetailsScreenState();
}

class _PatientDetailsScreenState extends State<PatientDetailsScreen> {
  final bool _isProcessing = false;
  late Map<String, dynamic> _patient;

  @override
  void initState() {
    super.initState();
    _patient = Map.from(widget.patient);
  }

  String _formatDate(String? dateStr) {
    if (dateStr == null) return 'N/A';
    try {
      final date = DateTime.parse(dateStr).toLocal();
      return DateFormat('MMM dd, yyyy').format(date);
    } catch (e) {
      return dateStr;
    }
  }

  Future<void> _editPatient() async {
    final result = await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) =>
            PatientFormScreen(isEditMode: true, patientData: _patient),
      ),
    );

    if (result != null && result is Map<String, dynamic>) {
      setState(() {
        _patient = result;
      });
      if (mounted) {
        ToastUtils.showSuccess(context, 'Patient updated successfully');
      }
    }
  }

  void _viewGallery() {
    final patientId = _patient['id'];

    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => MainGalleryScreen(
          patientId: patientId,
          folderId: _patient['drive_folder_id']?.toString(),
          patientName:
              '${_patient['first_name']} ${_patient['last_name'] ?? ''}'.trim(),
        ),
      ),
    );
  }

  void _viewUploadedPhotos() {
    final folderId = _patient['drive_folder_id']?.toString();
    if (folderId == null || folderId.isEmpty) {
      ToastUtils.showError(context, 'No folder found for this patient');
      return;
    }

    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => ViewPhotosScreen(
          folderId: folderId,
          patientName:
              '${_patient['first_name']} ${_patient['last_name'] ?? ''}'.trim(),
          patientId: widget.patient["id"],
        ),
      ),
    );
  }

  void _uploadDichargePhotos() {
    if (widget.patient["admission_type"] == "conservative") {
      Navigator.push(
        context,
        MaterialPageRoute(
          builder: (_) => ConservativeDischargeDocsUpload(patient: _patient),
        ),
      );
    } else if (widget.patient["admission_type"] == "surgical") {
      Navigator.push(
        context,
        MaterialPageRoute(
          builder: (_) => SurgicalDischargeDocsUpload(patient: _patient),
        ),
      );
    } else {
      return;
    }
  }

  @override
  Widget build(BuildContext context) {
    final fullName = '${_patient['first_name']} ${_patient['last_name'] ?? ''}'
        .trim();

    return Scaffold(
      appBar: AppBar(title: const Text('Patient Details')),
      body: SingleChildScrollView(
        child: Column(
          children: [
            // Patient Header Card
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(24),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [Colors.blue.shade400, Colors.blue.shade700],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
              ),
              child: Column(
                children: [
                  CircleAvatar(
                    radius: 50,
                    backgroundColor: Colors.white,
                    child: Text(
                      fullName.isNotEmpty ? fullName[0].toUpperCase() : '?',
                      style: TextStyle(
                        fontSize: 40,
                        fontWeight: FontWeight.bold,
                        color: Colors.blue.shade700,
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    fullName,
                    style: const TextStyle(
                      fontSize: 24,
                      fontWeight: FontWeight.bold,
                      color: Colors.white,
                    ),
                  ),
                ],
              ),
            ),

            // Patient Information Cards
            Padding(
              padding: const EdgeInsets.all(16.0),
              child: Column(
                children: [
                  const SizedBox(height: 12),
                  _buildInfoCard(
                    icon: Icons.calendar_today,
                    title: 'Admission Date',
                    value: _formatDate(_patient['admitted_at']),
                  ),
                ],
              ),
            ),

            // Action Buttons
            Padding(
              padding: const EdgeInsets.all(16.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ElevatedButton.icon(
                    onPressed: _isProcessing ? null : _viewGallery,
                    icon: const Icon(Icons.photo_library),
                    label: const Text('Upload Treatment Documents'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.cyan,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 16),
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (widget.patient["admission_type"] != null)
                    ElevatedButton.icon(
                      onPressed: _isProcessing ? null : _uploadDichargePhotos,
                      icon: const Icon(Icons.photo_library),
                      label: const Text('Upload Discharge Documents'),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: Colors.teal,
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(vertical: 16),
                      ),
                    ),
                  if (widget.patient["admission_type"] != null)
                    const SizedBox(height: 12),
                  ElevatedButton.icon(
                    onPressed: _isProcessing ? null : _viewUploadedPhotos,
                    icon: const Icon(Icons.photo_album),
                    label: const Text('View Uploaded Photos'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.green,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 16),
                    ),
                  ),
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    onPressed: _isProcessing ? null : _editPatient,
                    icon: const Icon(Icons.edit),
                    label: const Text('Edit Information'),
                    style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildInfoCard({
    required IconData icon,
    required String title,
    required String value,
  }) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Row(
          children: [
            Icon(icon, color: Colors.blue.shade700, size: 28),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    value,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
