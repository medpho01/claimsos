import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../services/api_service.dart';
import '../utils/toast_utils.dart';
import 'gallery.screen.dart';
import 'patient_form.screen.dart';

class PatientDetailsScreen extends StatefulWidget {
  final Map<String, dynamic> patient;

  const PatientDetailsScreen({required this.patient, super.key});

  @override
  State<PatientDetailsScreen> createState() => _PatientDetailsScreenState();
}

class _PatientDetailsScreenState extends State<PatientDetailsScreen> {
  final ApiService _api = ApiService();
  bool _isProcessing = false;
  late Map<String, dynamic> _patient;

  // Explicit state variables for reliable UI updates
  bool _isDischargedState = false;
  String? _dischargedAt;

  @override
  void initState() {
    super.initState();
    _patient = Map.from(widget.patient);
    _initializeState();
  }

  void _initializeState() {
    _dischargedAt = _patient['discharged_at'];
    _isDischargedState =
        _dischargedAt != null && _dischargedAt.toString().isNotEmpty;
  }

  String _formatDate(String? dateStr) {
    if (dateStr == null) return 'N/A';
    try {
      final date = DateTime.parse(dateStr);
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
        _initializeState(); // Re-init state from updated patient data
      });
      if (mounted) {
        ToastUtils.showSuccess(context, 'Patient updated successfully');
      }
    }
  }

  Future<void> _toggleDischarge() async {
    setState(() => _isProcessing = true);

    try {
      final currentlyDischarged = _isDischargedState;
      final now = DateTime.now().toIso8601String();

      print(
        '[DISCHARGE] Current state: ${currentlyDischarged ? 'DISCHARGED' : 'ADMITTED'}',
      );
      print(
        '[DISCHARGE] Sending dischargedAt: ${currentlyDischarged ? 'null (re-admit)' : now}',
      );

      final response = await _api.patch(
        '/patient/${_patient['id']}/discharge',
        data: {'dischargedAt': currentlyDischarged ? null : now},
      );

      if (!mounted) return;

      if (response.statusCode == 200) {
        print('[DISCHARGE] Response data: ${response.data}');
        final updatedPatient = response.data['data'];

        setState(() {
          _patient = updatedPatient;
          _dischargedAt = updatedPatient['discharged_at'];
          _isDischargedState =
              _dischargedAt != null && _dischargedAt.toString().isNotEmpty;
          _isProcessing = false;
        });

        print(
          '[DISCHARGE] New state: ${_isDischargedState ? 'DISCHARGED' : 'ADMITTED'}',
        );

        ToastUtils.showSuccess(
          context,
          currentlyDischarged ? 'Patient re-admitted' : 'Patient discharged',
        );
      }
    } catch (e) {
      print('[DISCHARGE] Error: $e');
      if (mounted) {
        setState(() => _isProcessing = false);
        ToastUtils.showError(context, 'Failed to update patient status');
      }
    }
  }

  void _viewGallery() {
    final patientId = _patient['id'] is String
        ? int.tryParse(_patient['id'])
        : _patient['id'] as int?;

    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => MainGalleryScreen(
          patientId: patientId,
          folderId: _patient['folder_id']?.toString(),
          patientName:
              '${_patient['first_name']} ${_patient['last_name'] ?? ''}'.trim(),
          patientPhone: _patient['phone']?.toString(),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    print('[BUILD] _isDischargedState: $_isDischargedState');

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
                  const SizedBox(height: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 6,
                    ),
                    decoration: BoxDecoration(
                      color: _isDischargedState
                          ? Colors.grey.shade600
                          : Colors.green.shade600,
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(
                      _isDischargedState ? 'Discharged' : 'Admitted',
                      style: const TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.w600,
                      ),
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
                  _buildInfoCard(
                    icon: Icons.phone,
                    title: 'Phone Number',
                    value: _patient['phone'] ?? 'N/A',
                  ),
                  const SizedBox(height: 12),
                  _buildInfoCard(
                    icon: Icons.calendar_today,
                    title: 'Admission Date',
                    value: _formatDate(_patient['admitted_at']),
                  ),
                  if (_isDischargedState) ...[
                    const SizedBox(height: 12),
                    _buildInfoCard(
                      icon: Icons.event_available,
                      title: 'Discharge Date',
                      value: _formatDate(_dischargedAt),
                    ),
                  ],
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
                      backgroundColor: Colors.blue,
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
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    onPressed: _isProcessing ? null : _toggleDischarge,
                    icon: Icon(
                      _isDischargedState ? Icons.person_add : Icons.how_to_reg,
                    ),
                    label: Text(
                      _isDischargedState
                          ? 'Re-admit Patient'
                          : 'Discharge Patient',
                    ),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: _isDischargedState
                          ? Colors.green
                          : Colors.orange,
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
