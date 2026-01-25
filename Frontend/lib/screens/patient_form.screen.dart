import 'package:dio/src/response.dart';
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
  final _admittedOn = TextEditingController();
  final _panel = TextEditingController();

  String? _selectedPanelId;
  List<Map<String, String>> _roles = [];

  final ApiService _api = ApiService();
  bool _isSubmitting = false;
  bool _isLoading = true;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _initializeData();
  }

  void _initializeData() {
    if (widget.isEditMode && widget.patientData != null) {
      _firstNameController.text = widget.patientData!['first_name'] ?? '';
      _lastNameController.text = widget.patientData!['last_name'] ?? '';

      _selectedPanelId = widget.patientData!['panel_id'];
      _panel.text = _selectedPanelId!;

      if (widget.patientData!['admitted_at'] != null) {
        try {
          final date = DateTime.parse(
            widget.patientData!['admitted_at'],
          ).toLocal();
          _admittedOn.text = date.toString().split(" ")[0];
        } catch (_) {}
      }
    }

    _loadRoles();
  }

  Future<void> _loadRoles() async {
    try {
      final response = await _api.get("/user/getHospitalUserRoles");

      if (mounted) {
        setState(() {
          _isLoading = false;

          final List<dynamic> rawData = response.data['data'] ?? [];

          _roles = rawData.map((item) {
            return {
              'panel_id': item['panel_id']?.toString() ?? '',
              'panel_name': item['panel_name']?.toString() ?? '',
            };
          }).toList();
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _errorMessage = 'Failed to load roles. Please retry.';
          _isLoading = false;
        });
      }
    }
  }

  @override
  void dispose() {
    _firstNameController.dispose();
    _lastNameController.dispose();
    _admittedOn.dispose();
    _panel.dispose();
    super.dispose();
  }

  Future<void> _submitForm() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      _isSubmitting = true;
      _errorMessage = null;
    });

    try {
      String dateText = _admittedOn.text;
      String isoString = DateTime.parse(dateText).toIso8601String();

      final data = {
        'firstName': _firstNameController.text.trim(),
        'lastName': _lastNameController.text.trim(),
        'admittedAt': isoString,
        'panelId': _panel.text,
      };

      late final Response<dynamic> response;

      if (widget.isEditMode) {
        data.addAll({
          "hospitalId": widget.patientData!["hospital_id"],
          "id": widget.patientData!["id"],
        });
        response = await _api.patch(
          '/patient/update/hospitalUser/${widget.patientData!['id']}',
          data: data,
        );
      } else {
        response = await _api.post('/patient/addPatient', data: data);
      }

      if (!mounted) return;

      if (response.statusCode == 200 || response.statusCode == 201) {
        final patientData = response.data['data'];
        print(patientData);
        Navigator.of(context).pop(patientData);
      } else {
        setState(() {
          _errorMessage = response.data['message'] ?? 'Operation failed';
        });
      }
    } catch (e) {
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
    // FIX 2: Check if _selectedPanelId exists in _roles
    // If the list loaded but doesn't contain the ID we have selected, reset it to null
    // otherwise the Dropdown crashes.
    String? safeValue;
    if (_roles.any((item) => item['panel_id'] == _selectedPanelId)) {
      safeValue = _selectedPanelId;
    }

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
                            : 'Enter patient details',
                        style: const TextStyle(
                          fontSize: 14,
                          color: Colors.black87,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 24),

              TextFormField(
                controller: _firstNameController,
                decoration: const InputDecoration(
                  labelText: 'First Name *',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.person),
                ),
                textCapitalization: TextCapitalization.words,
                validator: (value) =>
                    (value == null || value.trim().isEmpty) ? 'Required' : null,
                enabled: !_isSubmitting,
              ),
              const SizedBox(height: 16),

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

              TextFormField(
                controller: _admittedOn,
                decoration: const InputDecoration(
                  labelText: 'Admitted On *',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.calendar_today),
                ),
                readOnly: true,
                onTap: () async {
                  DateTime? pickedDate = await showDatePicker(
                    context: context,
                    initialDate: DateTime.now(),
                    firstDate: DateTime(2020),
                    lastDate: DateTime.now(),
                  );
                  if (pickedDate != null) {
                    setState(() {
                      _admittedOn.text =
                          "${pickedDate.year}-${pickedDate.month.toString().padLeft(2, '0')}-${pickedDate.day.toString().padLeft(2, '0')}";
                    });
                  }
                },
                validator: (value) =>
                    (value == null || value.isEmpty) ? 'Required' : null,
              ),
              const SizedBox(height: 24),

              if (!widget.isEditMode) ...[
                if (_isLoading)
                  const Center(child: CircularProgressIndicator())
                else if (_roles.isEmpty)
                  Center(
                    child: Column(
                      children: [
                        const Text(
                          'Failed to load panels',
                          style: TextStyle(color: Colors.red),
                        ),
                        TextButton.icon(
                          onPressed: () {
                            setState(() {
                              _isLoading = true;
                              _errorMessage = null;
                            });
                            _loadRoles();
                          },
                          icon: const Icon(Icons.refresh),
                          label: const Text('Retry'),
                        ),
                      ],
                    ),
                  )
                else
                  DropdownButtonFormField<String>(
                    value: safeValue,
                    decoration: const InputDecoration(
                      labelText: 'Select Panel *',
                      border: OutlineInputBorder(),
                      prefixIcon: Icon(Icons.local_hospital),
                    ),
                    items: _roles.map((Map<String, String> item) {
                      return DropdownMenuItem<String>(
                        value: item['panel_id'],
                        child: Text(item['panel_name']!),
                      );
                    }).toList(),
                    onChanged: (String? newValue) {
                      setState(() {
                        _selectedPanelId = newValue;
                        _panel.text = newValue ?? "";
                      });
                    },
                    validator: (value) => (value == null || value.isEmpty)
                        ? 'Please select a panel'
                        : null,
                    hint: const Text("Select Panel"),
                  ),
                const SizedBox(height: 24),
              ],

              if (_errorMessage != null)
                Container(
                  padding: const EdgeInsets.all(12),
                  margin: const EdgeInsets.only(bottom: 16),
                  color: Colors.red.shade50,
                  child: Text(
                    _errorMessage!,
                    style: TextStyle(color: Colors.red.shade700),
                  ),
                ),

              ElevatedButton(
                onPressed: _isSubmitting ? null : _submitForm,
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                ),
                child: _isSubmitting
                    ? const CircularProgressIndicator()
                    : Text(widget.isEditMode ? 'Update' : 'Create'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
