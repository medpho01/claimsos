import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:url_launcher/url_launcher.dart';
import '../services/api_service.dart';

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
  List<dynamic> _files = [];
  final Set<String> _selectedFileIds = {};
  bool _isLoading = true;
  bool _isDeleting = false;

  @override
  void initState() {
    super.initState();
    _initializeData();
  }

  Future<void> _initializeData() async {
    await _loadFromLocalStorage();
    _fetchFromApi();
  }

  Future<String> get _localPath async {
    final directory = await getApplicationDocumentsDirectory();
    return '${directory.path}/discharge_${widget.patientId}_${widget.category}.json';
  }

  Future<void> _loadFromLocalStorage() async {
    try {
      final file = File(await _localPath);
      if (await file.exists()) {
        final content = await file.readAsString();
        setState(() {
          _files = json.decode(content);
          _isLoading = false;
        });
      }
    } catch (_) {}
  }

  Future<void> _fetchFromApi() async {
    try {
      final files = await _apiService.getDischargePhotos(
        widget.patientId,
        widget.category,
      );
      setState(() {
        _files = files;
        _isLoading = false;
      });
      final file = File(await _localPath);
      await file.writeAsString(json.encode(files));
    } catch (e) {
      if (_files.isEmpty) setState(() => _isLoading = false);
    }
  }

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

  void _viewFullScreen(int index) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => FullScreenFileView(
          files: _files,
          initialIndex: index,
          onDelete: (fileId) async {
            final success = await _apiService.deletePhoto(
              fileId,
              widget.patientId,
              widget.folderId,
            );
            if (success) _fetchFromApi();
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
        actions: [
          if (!hasSelection)
            IconButton(
              icon: const Icon(Icons.refresh),
              onPressed: _fetchFromApi,
            ),
        ],
      ),
      body: _isLoading && _files.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : GridView.builder(
              padding: const EdgeInsets.all(8),
              gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 3,
                crossAxisSpacing: 4,
                mainAxisSpacing: 4,
              ),
              itemCount: _files.length,
              itemBuilder: (context, index) {
                final file = _files[index];
                final fileId = file['id'] as String;
                final isSelected = _selectedFileIds.contains(fileId);
                return GestureDetector(
                  onTap: () => hasSelection
                      ? _toggleSelection(fileId)
                      : _viewFullScreen(index),
                  onLongPress: () => _toggleSelection(fileId),
                  child: Container(
                    decoration: BoxDecoration(
                      border: isSelected
                          ? Border.all(color: Colors.blue, width: 3)
                          : null,
                    ),
                    child: _isPdf(file)
                        ? Container(
                            color: Colors.red.shade50,
                            child: const Icon(
                              Icons.picture_as_pdf,
                              color: Colors.red,
                            ),
                          )
                        : CachedNetworkImage(
                            imageUrl:
                                file['thumbnailLink']?.replaceAll(
                                  's220',
                                  's400',
                                ) ??
                                '',
                            cacheKey: fileId,
                            fit: BoxFit.cover,
                            memCacheWidth: 300,
                            placeholder: (context, url) =>
                                Container(color: Colors.grey.shade200),
                          ),
                  ),
                );
              },
            ),
    );
  }
}

class FullScreenFileView extends StatefulWidget {
  final List<dynamic> files;
  final int initialIndex;
  final Future<bool> Function(String fileId) onDelete;

  const FullScreenFileView({
    super.key,
    required this.files,
    required this.initialIndex,
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
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => _precache(_currentIndex),
    );
  }

  void _precache(int index) {
    if (index + 1 < widget.files.length) {
      final next = widget.files[index + 1];
      if (!(next['mimeType']?.contains('pdf') ?? false)) {
        precacheImage(
          CachedNetworkImageProvider(
            'https://drive.google.com/uc?id=${next['id']}',
            cacheKey: '${next['id']}_full',
          ),
          context,
        );
      }
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
      ),
      body: PageView.builder(
        controller: _pageController,
        allowImplicitScrolling: true,
        onPageChanged: (i) {
          setState(() => _currentIndex = i);
          _precache(i);
        },
        itemCount: widget.files.length,
        itemBuilder: (context, index) {
          final file = widget.files[index];
          final isPdf = file['mimeType']?.contains('pdf') ?? false;

          if (isPdf) {
            return Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(
                  Icons.picture_as_pdf,
                  size: 80,
                  color: Colors.white54,
                ),
                const SizedBox(height: 20),
                ElevatedButton(
                  onPressed: () => launchUrl(
                    Uri.parse(file['webViewLink']),
                    mode: LaunchMode.externalApplication,
                  ),
                  child: const Text('Open PDF'),
                ),
              ],
            );
          }

          return InteractiveViewer(
            child: CachedNetworkImage(
              imageUrl: 'https://drive.google.com/uc?id=${file['id']}',
              cacheKey: '${file['id']}_full',
              placeholder: (context, url) => CachedNetworkImage(
                imageUrl: file['thumbnailLink'] ?? '',
                fit: BoxFit.contain,
              ),
              errorWidget: (context, url, error) =>
                  const Icon(Icons.broken_image, color: Colors.white),
            ),
          );
        },
      ),
    );
  }
}
