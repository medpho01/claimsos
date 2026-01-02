import 'package:flutter/material.dart';
import 'package:photo_manager/photo_manager.dart';
import '../services/api_service.dart';
import '../services/upload_service.dart';

class PatientFormScreen extends StatefulWidget {
  final List<AssetEntity> selectedImages;

  const PatientFormScreen({required this.selectedImages, super.key});

  @override
  State<PatientFormScreen> createState() => _PatientFormScreenState();
}

class _PatientFormScreenState extends State<PatientFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _firstNameController = TextEditingController();
  final _lastNameController = TextEditingController();
  final _phoneController = TextEditingController();

  final ApiService _api = ApiService();
  final UploadService _uploadService = UploadService();
  bool _isSubmitting = false;
  String? _errorMessage;
  bool _isUploadingImages = false;

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
      print('📝 [FORM] Creating patient...');

      final response = await _api.post(
        '/patient/addPatient',
        data: {
          'firstName': _firstNameController.text.trim(),
          'lastName': _lastNameController.text.trim(),
          'phone': _phoneController.text.trim(),
        },
      );

      if (!mounted) return;

      if (response.statusCode == 201) {
        print('✅ [FORM] Patient created successfully');

        // Get folder_id from response
        final folderId = response.data['data']['folder_id'];

        if (widget.selectedImages.isNotEmpty && folderId != null) {
          print(
            '📤 [FORM] Uploading ${widget.selectedImages.length} images...',
          );

          setState(() {
            _isSubmitting = false;
            _isUploadingImages = true;
          });

          final uploadResult = await _uploadService.uploadImages(
            widget.selectedImages,
            folderId,
          );

          if (!mounted) return;

          setState(() => _isUploadingImages = false);

          if (uploadResult['success']) {
            print('✅ [FORM] Upload complete!');
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text('Patient and images uploaded successfully!'),
                backgroundColor: Colors.green,
              ),
            );
          } else {
            print('⚠️  [FORM] Upload had errors');
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text(
                  'Patient created, but image upload failed: ${uploadResult['message']}',
                ),
                backgroundColor: Colors.orange,
              ),
            );
          }
        } else {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Patient added successfully!'),
              backgroundColor: Colors.green,
            ),
          );
        }

        Navigator.of(context).pop(true);
      } else {
        setState(() {
          _errorMessage = response.data['message'] ?? 'Failed to add patient';
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
          _isUploadingImages = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Add Patient')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16.0),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Show selected images count
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.blue.shade50,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Colors.blue.shade200),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.image, color: Colors.blue),
                    const SizedBox(width: 8),
                    Text(
                      '${widget.selectedImages.length} image(s) selected',
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w500,
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
                onPressed: (_isSubmitting || _isUploadingImages)
                    ? null
                    : _submitForm,
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(8),
                  ),
                ),
                child: _isSubmitting
                    ? const Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          SizedBox(
                            height: 20,
                            width: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                          SizedBox(width: 12),
                          Text('Creating patient...'),
                        ],
                      )
                    : _isUploadingImages
                    ? const Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          SizedBox(
                            height: 20,
                            width: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                          SizedBox(width: 12),
                          Text('Uploading images...'),
                        ],
                      )
                    : const Text('Submit', style: TextStyle(fontSize: 16)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
