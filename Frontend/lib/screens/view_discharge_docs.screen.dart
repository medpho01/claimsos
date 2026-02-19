import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../services/api_service.dart';
import '../widgets/pdf_viewer.dart';

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
  final Set<int> _selectedIndices = {};
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _initData();
  }

  Future<void> _initData() async {
    await _loadFromLocal();
    if (_files.isNotEmpty && mounted) {
      setState(() => _isLoading = false);
    }
    await _fetchFromApi();
  }

  Future<String> get _localPath async {
    final directory = await getApplicationDocumentsDirectory();
    return '${directory.path}/discharge_${widget.patientId}_${widget.category}.json';
  }

  Future<void> _loadFromLocal() async {
    try {
      final file = File(await _localPath);
      if (await file.exists()) {
        final content = await file.readAsString();
        if (mounted) {
          setState(() {
            _files = json.decode(content);
          });
        }
      }
    } catch (e) {
      debugPrint("$e");
    }
  }

  Future<void> _fetchFromApi() async {
    try {
      final files = await _apiService.getDischargePhotos(
        widget.patientId,
        widget.category,
      );
      if (mounted) {
        setState(() {
          _files = files;
          _isLoading = false;
        });
        final file = File(await _localPath);
        await file.writeAsString(json.encode(files));
      }
    } catch (e) {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  void _toggleSelection(int index) {
    setState(() {
      if (_selectedIndices.contains(index)) {
        _selectedIndices.remove(index);
      } else {
        _selectedIndices.add(index);
      }
    });
  }

  String _getThumbnailUrl(dynamic file) {
    String url = file['thumbnailLink'] ?? file['webViewLink'] ?? '';
    if (url.contains('googleusercontent.com') && url.contains('s220')) {
      return url.replaceAll('s220', 's400');
    }
    return url;
  }

  Future<void> _renameFile() async {
    final selectedFiles = _files.asMap().entries.where(
      (entry) => _selectedIndices.contains(entry.key),
    );

    final fileIds = selectedFiles
        .map((x) => {"fileId": x.value['id'], "fileName": x.value['name']})
        .toList();

    final controller = TextEditingController(text: widget.patientName);

    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text("Rename Discharge Files"),
        content: TextField(
          controller: controller,
          decoration: const InputDecoration(hintText: "Enter new name"),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text("Cancel"),
          ),
          TextButton(
            onPressed: () async {
              final newName = controller.text;
              Navigator.pop(context);
              setState(() => _isLoading = true);
              try {
                await _apiService.renameFile(
                  fileIds,
                  widget.patientId,
                  newName,
                );
                _selectedIndices.clear();
                await _fetchFromApi();
              } catch (e) {
                setState(() => _isLoading = false);
              }
            },
            child: const Text("Rename"),
          ),
        ],
      ),
    );
  }

  Future<void> _deleteSelected() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text("Delete Files"),
        content: Text("Delete ${_selectedIndices.length} selected item(s)?"),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text("Cancel"),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text("Delete", style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      setState(() => _isLoading = true);
      try {
        List<String> selectedIds = [];
        for (var index in _selectedIndices) {
          selectedIds.add(_files[index]['id']);
        }

        await _apiService.deletePhotos(selectedIds, widget.patientId);

        _selectedIndices.clear();
        await _fetchFromApi();
      } catch (e) {
        setState(() => _isLoading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final bool isSelecting = _selectedIndices.isNotEmpty;

    return Scaffold(
      appBar: AppBar(
        title: Text(
          !isSelecting || _isLoading
              ? "${widget.category} Docs"
              : "${_selectedIndices.length} selected",
        ),
        actions: [
          if (isSelecting && !_isLoading) ...[
            IconButton(icon: const Icon(Icons.edit), onPressed: _renameFile),
            IconButton(
              icon: const Icon(Icons.delete),
              onPressed: _deleteSelected,
            ),
          ],
          IconButton(icon: const Icon(Icons.refresh), onPressed: _fetchFromApi),
        ],
      ),
      body: _isLoading && _files.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _fetchFromApi,
              child: GridView.builder(
                padding: const EdgeInsets.all(8),
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 3,
                  crossAxisSpacing: 4,
                  mainAxisSpacing: 4,
                ),
                itemCount: _files.length,
                itemBuilder: (context, index) {
                  final file = _files[index];
                  final isSelected = _selectedIndices.contains(index);
                  final isPdf = file['mimeType']?.contains('pdf') ?? false;

                  return GestureDetector(
                    onLongPress: () => _toggleSelection(index),
                    onTap: () {
                      if (isSelecting) {
                        _toggleSelection(index);
                      } else {
                        Navigator.push(
                          context,
                          MaterialPageRoute(
                            builder: (_) => FullScreenFileView(
                              files: _files,
                              initialIndex: index,
                            ),
                          ),
                        ).then((_) => _fetchFromApi());
                      }
                    },
                    child: Stack(
                      fit: StackFit.expand,
                      children: [
                        isPdf
                            ? Container(
                                color: Colors.red.shade50,
                                child: const Icon(
                                  Icons.picture_as_pdf,
                                  color: Colors.red,
                                  size: 40,
                                ),
                              )
                            : CachedNetworkImage(
                                imageUrl: _getThumbnailUrl(file),
                                fit: BoxFit.cover,
                                cacheKey: file['id'],
                                memCacheWidth: 300,
                                errorWidget: (context, url, error) =>
                                    const Icon(Icons.insert_drive_file),
                              ),
                        if (isSelected)
                          Container(
                            color: Colors.blue.withOpacity(0.4),
                            child: const Icon(
                              Icons.check_circle,
                              color: Colors.white,
                            ),
                          ),
                      ],
                    ),
                  );
                },
              ),
            ),
    );
  }
}

class FullScreenFileView extends StatefulWidget {
  final List<dynamic> files;
  final int initialIndex;

  const FullScreenFileView({
    super.key,
    required this.files,
    required this.initialIndex,
  });

  @override
  State<FullScreenFileView> createState() => _FullScreenFileViewState();
}

class _FullScreenFileViewState extends State<FullScreenFileView> {
  late PageController _pageController;
  late int _currentIndex;

  @override
  void initState() {
    super.initState();
    _currentIndex = widget.initialIndex;
    _pageController = PageController(initialPage: widget.initialIndex);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        iconTheme: const IconThemeData(color: Colors.white),
        title: Text(
          '${_currentIndex + 1} / ${widget.files.length}',
          style: const TextStyle(color: Colors.white),
        ),
      ),
      body: PageView.builder(
        controller: _pageController,
        onPageChanged: (i) => setState(() => _currentIndex = i),
        itemCount: widget.files.length,
        itemBuilder: (context, index) {
          final file = widget.files[index];
          final isPdf = file['mimeType']?.contains('pdf') ?? false;

          if (isPdf) {
            return CachedPdfViewer(
              url: file['webViewLink'] ?? '',
              fileId: file['id'],
            );
          }

          return InteractiveViewer(
            child: CachedNetworkImage(
              imageUrl: file['webViewLink'] ?? '',
              cacheKey: "${file['id']}_full",
              placeholder: (context, url) => CachedNetworkImage(
                imageUrl: file['thumbnailLink'] ?? file['webViewLink'] ?? '',
                cacheKey: file['id'],
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
