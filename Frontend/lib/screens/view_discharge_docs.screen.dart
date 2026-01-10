import 'package:flutter/material.dart';
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
  State<ViewDischargePhotosScreen> createState() => _ViewPhotosScreenState();
}

class _ViewPhotosScreenState extends State<ViewDischargePhotosScreen> {
  final ApiService _apiService = ApiService();
  List<dynamic> _photos = [];
  Set<String> _selectedPhotoIds = {};
  bool _isLoading = true;
  bool _isDeleting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadPhotos();
  }

  Future<void> _loadPhotos() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final photos = await _apiService.getDischargePhotos(
        widget.patientId,
        widget.category,
      );
      print(photos);
      setState(() {
        _photos = photos;
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _error = 'Failed to load photos: $e';
        _isLoading = false;
      });
    }
  }

  void _toggleSelection(String photoId) {
    setState(() {
      if (_selectedPhotoIds.contains(photoId)) {
        _selectedPhotoIds.remove(photoId);
      } else {
        _selectedPhotoIds.add(photoId);
      }
    });
  }

  void _clearSelection() {
    setState(() {
      _selectedPhotoIds.clear();
    });
  }

  Future<void> _deleteSelectedPhotos() async {
    if (_selectedPhotoIds.isEmpty) return;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete Photos'),
        content: Text(
          'Are you sure you want to delete ${_selectedPhotoIds.length} photo(s)? This action cannot be undone.',
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

    for (final photoId in _selectedPhotoIds) {
      try {
        await _apiService.deletePhoto(photoId, widget.folderId);
        successCount++;
      } catch (e) {
        failCount++;
        print('Failed to delete photo $photoId: $e');
      }
    }

    if (mounted) {
      if (successCount > 0) {
        ToastUtils.showSuccess(context, '$successCount photo(s) deleted');
      }
      if (failCount > 0) {
        ToastUtils.showError(context, 'Failed to delete $failCount photo(s)');
      }

      _clearSelection();
      _loadPhotos();
    }

    setState(() => _isDeleting = false);
  }

  void _viewFullScreen(int index) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => FullScreenPhotoView(
          photos: _photos,
          initialIndex: index,
          folderId: widget.folderId,
          onDelete: (photoId) async {
            final success = await _apiService.deletePhoto(
              photoId,
              widget.folderId,
            );
            if (success) {
              _loadPhotos();
            }
            return success;
          },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final bool hasSelection = _selectedPhotoIds.isNotEmpty;

    return Scaffold(
      appBar: AppBar(
        title: Text(
          hasSelection
              ? '${_selectedPhotoIds.length} Selected'
              : 'Uploaded Photos',
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
              onPressed: _isDeleting ? null : _deleteSelectedPhotos,
            ),
          if (!hasSelection)
            IconButton(icon: const Icon(Icons.refresh), onPressed: _loadPhotos),
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
            Text('Loading photos...'),
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
              onPressed: _loadPhotos,
              icon: const Icon(Icons.refresh),
              label: const Text('Retry'),
            ),
          ],
        ),
      );
    }

    if (_photos.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.photo_library_outlined,
              size: 80,
              color: Colors.grey.shade400,
            ),
            const SizedBox(height: 16),
            Text(
              'No photos uploaded yet',
              style: TextStyle(fontSize: 18, color: Colors.grey.shade600),
            ),
            const SizedBox(height: 8),
            Text(
              'Upload photos using "Upload Treatment Documents"',
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
                  ),
                ),
              ),
              Text(
                '${_photos.length} photo(s)',
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
            itemCount: _photos.length,
            itemBuilder: (context, index) {
              final photo = _photos[index];
              final photoId = photo['id'] as String;
              final isSelected = _selectedPhotoIds.contains(photoId);
              final thumbnailUrl = photo['thumbnailLink'] as String?;
              final name = photo['name'] as String? ?? 'Photo';

              return GestureDetector(
                onTap: () {
                  if (_selectedPhotoIds.isNotEmpty) {
                    _toggleSelection(photoId);
                  } else {
                    _viewFullScreen(index);
                  }
                },
                onLongPress: () => _toggleSelection(photoId),
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
                        child: thumbnailUrl != null
                            ? Image.network(
                                thumbnailUrl,
                                fit: BoxFit.cover,
                                errorBuilder: (_, __, ___) =>
                                    _buildPlaceholder(name),
                                loadingBuilder: (_, child, loadingProgress) {
                                  if (loadingProgress == null) return child;
                                  return Center(
                                    child: CircularProgressIndicator(
                                      value:
                                          loadingProgress.expectedTotalBytes !=
                                              null
                                          ? loadingProgress
                                                    .cumulativeBytesLoaded /
                                                loadingProgress
                                                    .expectedTotalBytes!
                                          : null,
                                      strokeWidth: 2,
                                    ),
                                  );
                                },
                              )
                            : _buildPlaceholder(name),
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

// Full screen photo viewer
class FullScreenPhotoView extends StatefulWidget {
  final List<dynamic> photos;
  final int initialIndex;
  final String folderId;
  final Future<bool> Function(String photoId) onDelete;

  const FullScreenPhotoView({
    super.key,
    required this.photos,
    required this.initialIndex,
    required this.folderId,
    required this.onDelete,
  });

  @override
  State<FullScreenPhotoView> createState() => _FullScreenPhotoViewState();
}

class _FullScreenPhotoViewState extends State<FullScreenPhotoView> {
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

  Future<void> _deleteCurrentPhoto() async {
    final photo = widget.photos[_currentIndex];
    final photoId = photo['id'] as String;
    final name = photo['name'] as String? ?? 'Photo';

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete Photo'),
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
      final success = await widget.onDelete(photoId);
      if (success && mounted) {
        ToastUtils.showSuccess(context, 'Photo deleted');
        Navigator.pop(context);
      }
    } catch (e) {
      if (mounted) {
        ToastUtils.showError(context, 'Failed to delete photo');
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
        title: Text('${_currentIndex + 1} / ${widget.photos.length}'),
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
            onPressed: _isDeleting ? null : _deleteCurrentPhoto,
          ),
        ],
      ),
      body: PageView.builder(
        controller: _pageController,
        onPageChanged: (index) {
          setState(() => _currentIndex = index);
        },
        itemCount: widget.photos.length,
        itemBuilder: (context, index) {
          final photo = widget.photos[index];
          final webViewLink = photo['webViewLink'] as String?;
          final directLink = photo['id'] != null
              ? 'https://drive.google.com/uc?id=${photo['id']}'
              : null;
          final name = photo['name'] as String? ?? 'Photo';

          return InteractiveViewer(
            minScale: 0.5,
            maxScale: 4.0,
            child: Center(
              child: directLink != null
                  ? Image.network(
                      directLink,
                      fit: BoxFit.contain,
                      errorBuilder: (_, error, ___) => Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          const Icon(
                            Icons.broken_image,
                            size: 64,
                            color: Colors.white54,
                          ),
                          const SizedBox(height: 16),
                          Text(
                            name,
                            style: const TextStyle(color: Colors.white70),
                          ),
                          const SizedBox(height: 8),
                          if (webViewLink != null)
                            TextButton(
                              onPressed: () {
                                // Could open in browser
                              },
                              child: const Text('Open in Browser'),
                            ),
                        ],
                      ),
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
                  : Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(
                          Icons.image,
                          size: 64,
                          color: Colors.white54,
                        ),
                        const SizedBox(height: 16),
                        Text(
                          name,
                          style: const TextStyle(color: Colors.white70),
                        ),
                      ],
                    ),
            ),
          );
        },
      ),
    );
  }
}
