import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart'; // Import url_launcher
import '../services/api_service.dart';
import '../utils/toast_utils.dart';

class ViewDischargePhotosScreen extends StatefulWidget {
  final String folderId;
  final String patientName;
  final String patientId;
  final String category;

  const ViewDischargePhotosScreen({
    super.key,
    required this.folderId,
    required this.patientName,
    required this.category,
    required this.patientId,
  });

  @override
  State<ViewDischargePhotosScreen> createState() =>
      _ViewDischargePhotosScreenState();
}

class _ViewDischargePhotosScreenState extends State<ViewDischargePhotosScreen> {
  final ApiService _apiService = ApiService();
  List<dynamic> _files = []; // Renamed to _files to reflect mixed content
  final Set<String> _selectedFileIds = {};
  bool _isLoading = true;
  bool _isDeleting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadFiles();
  }

  Future<void> _loadFiles() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final files = await _apiService.getDischargePhotos(
        widget.patientId,
        widget.category,
      );
      print(files);
      setState(() {
        _files = files;
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _error = 'Failed to load documents: $e';
        _isLoading = false;
      });
    }
  }

  // Helper to check if file is PDF
  bool _isPdf(dynamic file) {
    final mimeType = file['mimeType']?.toString().toLowerCase();
    final name = file['name']?.toString().toLowerCase() ?? '';
    return mimeType == 'application/pdf' || name.endsWith('.pdf');
  }

  void _toggleSelection(String fileId) {
    setState(() {
      if (_selectedFileIds.contains(fileId)) {
        _selectedFileIds.remove(fileId);
      } else {
        _selectedFileIds.add(fileId);
      }
    });
  }

  void _clearSelection() {
    setState(() {
      _selectedFileIds.clear();
    });
  }

  Future<void> _deleteSelectedFiles() async {
    if (_selectedFileIds.isEmpty) return;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete Files'),
        content: Text(
          'Are you sure you want to delete ${_selectedFileIds.length} item(s)? This action cannot be undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('Delete'),
          ),
        ],
      ),
    );

    if (confirmed != true) return;

    setState(() => _isDeleting = true);

    int successCount = 0;
    int failCount = 0;

    for (final fileId in _selectedFileIds) {
      try {
        await _apiService.deletePhoto(
          fileId,
          widget.patientId,
          widget.folderId,
        );
        successCount++;
      } catch (e) {
        failCount++;
      }
    }

    if (mounted) {
      if (successCount > 0) {
        ToastUtils.showSuccess(context, '$successCount item(s) deleted');
      }
      if (failCount > 0) {
        ToastUtils.showError(context, 'Failed to delete $failCount item(s)');
      }

      _clearSelection();
      _loadFiles();
    }

    setState(() => _isDeleting = false);
  }

  void _viewFullScreen(int index) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => FullScreenFileView(
          files: _files,
          initialIndex: index,
          folderId: widget.folderId,
          onDelete: (fileId) async {
            final success = await _apiService.deletePhoto(
              fileId,
              widget.patientId,
              widget.folderId,
            );
            if (success) {
              _loadFiles();
            }
            return success;
          },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final bool hasSelection = _selectedFileIds.isNotEmpty;

    return Scaffold(
      appBar: AppBar(
        title: Text(
          hasSelection
              ? '${_selectedFileIds.length} Selected'
              : '${widget.category} Docs',
        ),
        backgroundColor: hasSelection ? Colors.blue.shade700 : null,
        leading: hasSelection
            ? IconButton(
                icon: const Icon(Icons.close),
                onPressed: _clearSelection,
              )
            : null,
        actions: [
          if (hasSelection)
            IconButton(
              icon: _isDeleting
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                      ),
                    )
                  : const Icon(Icons.delete),
              onPressed: _isDeleting ? null : _deleteSelectedFiles,
            ),
          if (!hasSelection)
            IconButton(icon: const Icon(Icons.refresh), onPressed: _loadFiles),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_isLoading) {
      return const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            CircularProgressIndicator(),
            SizedBox(height: 16),
            Text('Loading documents...'),
          ],
        ),
      );
    }

    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.error_outline, size: 64, color: Colors.red.shade300),
            const SizedBox(height: 16),
            Text(_error!, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: _loadFiles,
              icon: const Icon(Icons.refresh),
              label: const Text('Retry'),
            ),
          ],
        ),
      );
    }

    if (_files.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.folder_open_outlined,
              size: 80,
              color: Colors.grey.shade400,
            ),
            const SizedBox(height: 16),
            Text(
              'No documents found',
              style: TextStyle(fontSize: 18, color: Colors.grey.shade600),
            ),
            const SizedBox(height: 8),
            Text(
              'Upload documents to see them here',
              style: TextStyle(fontSize: 14, color: Colors.grey.shade500),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      );
    }

    return Column(
      children: [
        Container(
          padding: const EdgeInsets.all(12),
          color: Colors.grey.shade100,
          child: Row(
            children: [
              Icon(Icons.person, color: Colors.blue.shade700),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  widget.patientName,
                  style: const TextStyle(
                    fontWeight: FontWeight.bold,
                    fontSize: 16,
                    color: Colors.black87,
                  ),
                ),
              ),
              Text(
                '${_files.length} file(s)',
                style: TextStyle(color: Colors.grey.shade600),
              ),
            ],
          ),
        ),
        Expanded(
          child: GridView.builder(
            padding: const EdgeInsets.all(8),
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 3,
              crossAxisSpacing: 8,
              mainAxisSpacing: 8,
            ),
            itemCount: _files.length,
            itemBuilder: (context, index) {
              final file = _files[index];
              final fileId = file['id'] as String;
              final isSelected = _selectedFileIds.contains(fileId);
              final thumbnailUrl = file['thumbnailLink'] as String?;
              final name = file['name'] as String? ?? 'File';
              final isPdf = _isPdf(file);

              return GestureDetector(
                onTap: () {
                  if (_selectedFileIds.isNotEmpty) {
                    _toggleSelection(fileId);
                  } else {
                    _viewFullScreen(index);
                  }
                },
                onLongPress: () => _toggleSelection(fileId),
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    Container(
                      decoration: BoxDecoration(
                        color: Colors.grey.shade200,
                        borderRadius: BorderRadius.circular(8),
                        border: isSelected
                            ? Border.all(color: Colors.blue, width: 3)
                            : null,
                      ),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(isSelected ? 5 : 8),
                        child: isPdf
                            ? _buildPdfThumbnail(name)
                            : _buildImageThumbnail(thumbnailUrl, name),
                      ),
                    ),
                    if (isSelected)
                      Positioned(
                        top: 4,
                        right: 4,
                        child: Container(
                          decoration: const BoxDecoration(
                            color: Colors.blue,
                            shape: BoxShape.circle,
                          ),
                          padding: const EdgeInsets.all(4),
                          child: const Icon(
                            Icons.check,
                            color: Colors.white,
                            size: 16,
                          ),
                        ),
                      ),
                  ],
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _buildPdfThumbnail(String name) {
    return Container(
      color: Colors.red.shade50,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.picture_as_pdf, color: Colors.red.shade400, size: 40),
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Text(
              name,
              style: TextStyle(fontSize: 10, color: Colors.red.shade900),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildImageThumbnail(String? thumbnailUrl, String name) {
    if (thumbnailUrl == null) return _buildPlaceholder(name);
    return Image.network(
      thumbnailUrl,
      fit: BoxFit.cover,
      errorBuilder: (_, __, ___) => _buildPlaceholder(name),
      loadingBuilder: (_, child, loadingProgress) {
        if (loadingProgress == null) return child;
        return const Center(
          child: SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        );
      },
    );
  }

  Widget _buildPlaceholder(String name) {
    return Container(
      color: Colors.grey.shade300,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.image, color: Colors.grey.shade500, size: 32),
          const SizedBox(height: 4),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Text(
              name,
              style: TextStyle(fontSize: 10, color: Colors.grey.shade600),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
            ),
          ),
        ],
      ),
    );
  }
}

// Full screen viewer for Photos and PDFs
class FullScreenFileView extends StatefulWidget {
  final List<dynamic> files;
  final int initialIndex;
  final String folderId;
  final Future<bool> Function(String fileId) onDelete;

  const FullScreenFileView({
    super.key,
    required this.files,
    required this.initialIndex,
    required this.folderId,
    required this.onDelete,
  });

  @override
  State<FullScreenFileView> createState() => _FullScreenFileViewState();
}

class _FullScreenFileViewState extends State<FullScreenFileView> {
  late PageController _pageController;
  late int _currentIndex;
  bool _isDeleting = false;

  @override
  void initState() {
    super.initState();
    _currentIndex = widget.initialIndex;
    _pageController = PageController(initialPage: widget.initialIndex);
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  bool _isPdf(dynamic file) {
    final mimeType = file['mimeType']?.toString().toLowerCase();
    final name = file['name']?.toString().toLowerCase() ?? '';
    return mimeType == 'application/pdf' || name.endsWith('.pdf');
  }

  // Safe launcher to prevent crashes
  Future<void> _openPdf(String? webViewLink) async {
    if (webViewLink == null) {
      ToastUtils.showError(context, 'No link available for this PDF');
      return;
    }

    final Uri url = Uri.parse(webViewLink);

    try {
      final bool launched = await launchUrl(
        url,
        mode: LaunchMode.externalApplication,
      );

      if (!launched) {
        // Fallback for some Android versions
        await launchUrl(url, mode: LaunchMode.platformDefault);
      }
    } catch (e) {
      print('Error launching URL: $e');
      if (mounted) {
        ToastUtils.showError(context, 'Could not open PDF viewer');
      }
    }
  }

  Future<void> _deleteCurrentFile() async {
    final file = widget.files[_currentIndex];
    final fileId = file['id'] as String;
    final name = file['name'] as String? ?? 'File';

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete File'),
        content: Text('Are you sure you want to delete "$name"?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('Delete'),
          ),
        ],
      ),
    );

    if (confirmed != true) return;

    setState(() => _isDeleting = true);

    try {
      final success = await widget.onDelete(fileId);
      if (success && mounted) {
        ToastUtils.showSuccess(context, 'File deleted');
        Navigator.pop(context);
      }
    } catch (e) {
      if (mounted) {
        ToastUtils.showError(context, 'Failed to delete file');
      }
    }

    if (mounted) {
      setState(() => _isDeleting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text('${_currentIndex + 1} / ${widget.files.length}'),
        actions: [
          IconButton(
            icon: _isDeleting
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                    ),
                  )
                : const Icon(Icons.delete),
            onPressed: _isDeleting ? null : _deleteCurrentFile,
          ),
        ],
      ),
      body: PageView.builder(
        controller: _pageController,
        onPageChanged: (index) {
          setState(() => _currentIndex = index);
        },
        itemCount: widget.files.length,
        itemBuilder: (context, index) {
          final file = widget.files[index];
          final webViewLink = file['webViewLink'] as String?;
          final directLink = file['id'] != null
              ? 'https://drive.google.com/uc?id=${file['id']}'
              : null;
          final name = file['name'] as String? ?? 'File';
          final isPdf = _isPdf(file);

          // PDF View Layout
          if (isPdf) {
            return Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(
                    Icons.picture_as_pdf,
                    size: 80,
                    color: Colors.white54,
                  ),
                  const SizedBox(height: 24),
                  Text(
                    name,
                    style: const TextStyle(color: Colors.white, fontSize: 18),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 32),
                  ElevatedButton.icon(
                    onPressed: () => _openPdf(webViewLink),
                    icon: const Icon(Icons.open_in_new),
                    label: const Text('Open PDF'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.blue,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(
                        horizontal: 24,
                        vertical: 12,
                      ),
                    ),
                  ),
                ],
              ),
            );
          }

          // Image View Layout
          return InteractiveViewer(
            minScale: 0.5,
            maxScale: 4.0,
            child: Center(
              child: directLink != null
                  ? Image.network(
                      directLink,
                      fit: BoxFit.contain,
                      errorBuilder: (_, error, ___) =>
                          _buildErrorState(name, webViewLink),
                      loadingBuilder: (_, child, loadingProgress) {
                        if (loadingProgress == null) return child;
                        return Center(
                          child: CircularProgressIndicator(
                            value: loadingProgress.expectedTotalBytes != null
                                ? loadingProgress.cumulativeBytesLoaded /
                                      loadingProgress.expectedTotalBytes!
                                : null,
                            valueColor: const AlwaysStoppedAnimation<Color>(
                              Colors.white,
                            ),
                          ),
                        );
                      },
                    )
                  : _buildErrorState(name, webViewLink),
            ),
          );
        },
      ),
    );
  }

  Widget _buildErrorState(String name, String? webViewLink) {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        const Icon(Icons.broken_image, size: 64, color: Colors.white54),
        const SizedBox(height: 16),
        Text(name, style: const TextStyle(color: Colors.white70)),
        const SizedBox(height: 8),
        if (webViewLink != null)
          TextButton(
            onPressed: () =>
                _openPdf(webViewLink), // Try opening in browser if image fails
            child: const Text('Open in Browser'),
          ),
      ],
    );
  }
}
