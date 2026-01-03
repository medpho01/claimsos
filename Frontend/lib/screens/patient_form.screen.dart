import 'package:flutter/material.dart';
import '../services/api_service.dart';
import '../utils/toast_utils.dart';

class PatientFormScreen extends StatefulWidget {
  final bool isEditMode;
  final Map<String, dynamic>? patientData;

  const PatientFormScreen({
    this.isEditMode = false,
    this.patientData,
    super.key,
  });

  @override
  State<PatientFormScreen> createState() => _PatientFormScreenState();
}

class _PatientFormScreenState extends State<PatientFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _firstNameController = TextEditingController();
  final _lastNameController = TextEditingController();
  final _phoneController = TextEditingController();

  final ApiService _api = ApiService();
  bool _isSubmitting = false;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    if (widget.isEditMode && widget.patientData != null) {
      _firstNameController.text = widget.patientData!['first_name'] ?? '';
      _lastNameController.text = widget.patientData!['last_name'] ?? '';
      _phoneController.text = widget.patientData!['phone'] ?? '';
    }
  }

  @override
  void dispose() {
    _firstNameController.dispose();
    _lastNameController.dispose();
    _phoneController.dispose();
    super.dispose();
  }

  Future<void> _submitForm() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      _isSubmitting = true;
      _errorMessage = null;
    });

    try {
      final data = {
        'firstName': _firstNameController.text.trim(),
        'lastName': _lastNameController.text.trim(),
        'phone': _phoneController.text.trim(),
      };

      late final response;

      if (widget.isEditMode) {
        print('📝 [FORM] Updating patient...');
        response = await _api.patch(
          '/patient/${widget.patientData!['id']}',
          data: data,
        );
      } else {
        print('📝 [FORM] Creating patient...');
        response = await _api.post('/patient/addPatient', data: data);
      }

      if (!mounted) return;

      if (response.statusCode == 200 || response.statusCode == 201) {
        print(
          '✅ [FORM] ${widget.isEditMode ? 'Updated' : 'Created'} successfully',
        );

        final patientData = response.data['data'];

        if (mounted) {
          ToastUtils.showSuccess(
            context,
            widget.isEditMode
                ? 'Patient updated successfully!'
                : 'Patient created successfully!',
          );
        }

        // Return patient data to the previous screen
        Navigator.of(context).pop({
          'id': patientData['id'],
          'folder_id': patientData['folder_id'],
          'first_name': patientData['first_name'],
          'last_name': patientData['last_name'],
          'phone': patientData['phone'],
          'admitted_at': patientData['admitted_at'],
          'discharged_at': patientData['discharged_at'],
        });
      } else {
        setState(() {
          _errorMessage =
              response.data['message'] ??
              'Failed to ${widget.isEditMode ? 'update' : 'add'} patient';
        });
      }
    } catch (e) {
      print('❌ [FORM] Error: $e');
      setState(() {
        _errorMessage = 'Error: ${e.toString()}';
      });
    } finally {
      if (mounted) {
        setState(() {
          _isSubmitting = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.isEditMode ? 'Edit Patient' : 'Add New Patient'),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16.0),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Info banner
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.blue.shade50,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Colors.blue.shade200),
                ),
                child: Row(
                  children: [
                    Icon(Icons.info_outline, color: Colors.blue.shade700),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        widget.isEditMode
                            ? 'Update patient information'
                            : 'Enter patient details to create a new patient record',
                        style: const TextStyle(fontSize: 14),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 24),

              // First Name
              TextFormField(
                controller: _firstNameController,
                decoration: const InputDecoration(
                  labelText: 'First Name *',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.person),
                ),
                textCapitalization: TextCapitalization.words,
                validator: (value) {
                  if (value == null || value.trim().isEmpty) {
                    return 'Please enter first name';
                  }
                  return null;
                },
                enabled: !_isSubmitting,
              ),
              const SizedBox(height: 16),

              // Last Name
              TextFormField(
                controller: _lastNameController,
                decoration: const InputDecoration(
                  labelText: 'Last Name',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.person_outline),
                ),
                textCapitalization: TextCapitalization.words,
                enabled: !_isSubmitting,
              ),
              const SizedBox(height: 16),

              // Phone
              TextFormField(
                controller: _phoneController,
                decoration: const InputDecoration(
                  labelText: 'Phone *',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.phone),
                ),
                keyboardType: TextInputType.phone,
                validator: (value) {
                  if (value == null || value.trim().isEmpty) {
                    return 'Please enter phone number';
                  }
                  if (value.trim().length < 10) {
                    return 'Phone number must be at least 10 digits';
                  }
                  return null;
                },
                enabled: !_isSubmitting,
              ),
              const SizedBox(height: 24),

              // Error message
              if (_errorMessage != null)
                Container(
                  padding: const EdgeInsets.all(12),
                  margin: const EdgeInsets.only(bottom: 16),
                  decoration: BoxDecoration(
                    color: Colors.red.shade50,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: Colors.red.shade200),
                  ),
                  child: Row(
                    children: [
                      Icon(Icons.error_outline, color: Colors.red.shade700),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          _errorMessage!,
                          style: TextStyle(color: Colors.red.shade700),
                        ),
                      ),
                    ],
                  ),
                ),

              // Submit button
              ElevatedButton(
                onPressed: _isSubmitting ? null : _submitForm,
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(8),
                  ),
                ),
                child: _isSubmitting
                    ? Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          const SizedBox(
                            height: 20,
                            width: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                          const SizedBox(width: 12),
                          Text(
                            widget.isEditMode
                                ? 'Updating...'
                                : 'Creating patient...',
                          ),
                        ],
                      )
                    : Text(
                        widget.isEditMode ? 'Update Patient' : 'Create Patient',
                        style: const TextStyle(fontSize: 16),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
