import 'package:flutter/material.dart';
import '../utils/toast_utils.dart';
import 'categoryUploads.screen.dart';
import 'view_photos.screen.dart';
import '../services/api_service.dart';

final ApiService apiService = ApiService();

class ConservativeDischargeDocsUpload extends StatefulWidget {
  final Map<String, dynamic> patient;

  const ConservativeDischargeDocsUpload({required this.patient, super.key});

  @override
  State<ConservativeDischargeDocsUpload> createState() =>
      _PatientDocumentsState();
}

class _PatientDocumentsState extends State<ConservativeDischargeDocsUpload> {
  bool _isLoading = false;
  String? _errorMessage;
  final List<String> _categories = [
    "Discharge Slip",
    "Investigations",
    "Treatment",
    "ICPs",
  ];

  Map<String, int> _fileCounts = {
    "Discharge Slip": 0,
    "Investigations": 0,
    "Treatment": 0,
    "ICPs": 0,
  };

  @override
  void initState() {
    super.initState();
    _fetchFileDetails();
  }

  Future<void> _fetchFileDetails() async {
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });
    _errorMessage = "";
    try {
      final response = await apiService.get(
        "/uploads/getImageCounts/${widget.patient["id"]}",
      );

      if (response.statusCode == 200) {
        final data = await response.data["data"];
        setState(() {
          _fileCounts = _fileCounts = Map<String, int>.from(data);
          _isLoading = false;
        });
      }
    } catch (e) {
      _errorMessage = e.toString();
    }
  }

  void _handleUpload(String category) async {
    final patientId = widget.patient['id'];

    if (widget.patient['folder_id'] == null) {
      ToastUtils.showError(context, 'Patient folder ID is missing');
      return;
    }

    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => CategoryUplaodScreen(
          patientId: patientId,
          folderId: widget.patient['folder_id']?.toString(),
          patientName:
              '${widget.patient['first_name']} ${widget.patient['last_name'] ?? ''}'
                  .trim(),
          patientPhone: widget.patient['phone']?.toString(),
          field: category,
        ),
      ),
    );
  }

  void _handleView(String category) {
    if ((_fileCounts[category] ?? 0) == 0) {
      ToastUtils.showError(context, 'No documents uploaded for $category yet');
      return;
    }

    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => ViewPhotosScreen(
          folderId: widget.patient['folder_id']?.toString() ?? '',
          patientName:
              '${widget.patient['first_name']} ${widget.patient['last_name'] ?? ''}'
                  .trim(),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Document Categories'),
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _fetchFileDetails,
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: _categories.length,
              separatorBuilder: (ctx, index) => const SizedBox(height: 12),
              itemBuilder: (context, index) {
                final category = _categories[index];
                final count = _fileCounts[category] ?? 0;
                return _buildCategoryCard(category, count);
              },
            ),
    );
  }

  Widget _buildCategoryCard(String title, int count) {
    final bool hasFiles = count > 0;

    return Card(
      elevation: 2,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: hasFiles ? Colors.blue.shade50 : Colors.grey.shade100,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Icon(
                hasFiles ? Icons.folder_shared : Icons.folder_open,
                color: hasFiles ? Colors.blue.shade700 : Colors.grey.shade500,
                size: 28,
              ),
            ),
            const SizedBox(width: 16),

            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      // color: Colors.black87,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    hasFiles ? '$count files uploaded' : 'No files yet',
                    style: TextStyle(
                      fontSize: 13,
                      color: hasFiles
                          ? Colors.green.shade700
                          : Colors.grey.shade600,
                      fontWeight: hasFiles
                          ? FontWeight.w500
                          : FontWeight.normal,
                    ),
                  ),
                ],
              ),
            ),

            // Action Buttons
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                // Upload Button (Always visible)
                IconButton(
                  onPressed: () => _handleUpload(title),
                  icon: const Icon(Icons.add_a_photo_outlined),
                  color: Colors.blue.shade600,
                  tooltip: 'Upload New',
                ),

                // View/Edit Button (Visible only if files exist)
                if (hasFiles)
                  IconButton(
                    onPressed: () => _handleView(title),
                    icon: const Icon(Icons.visibility_outlined),
                    color: Colors.teal.shade600,
                    tooltip: 'View & Edit',
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
