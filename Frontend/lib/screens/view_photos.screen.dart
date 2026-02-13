import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:url_launcher/url_launcher.dart';
import '../services/api_service.dart';

class ViewPhotosScreen extends StatefulWidget {
  final String patientId;
  final String patientName;
  final String folderId;

  const ViewPhotosScreen({
    super.key,
    required this.patientId,
    required this.patientName,
    required this.folderId,
  });

  @override
  State<ViewPhotosScreen> createState() => _ViewPhotosScreenState();
}

class _ViewPhotosScreenState extends State<ViewPhotosScreen> {
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
    await _fetchFromApi();
  }

  Future<String> get _localPath async {
    final directory = await getApplicationDocumentsDirectory();
    return '${directory.path}/patient_${widget.patientId}_files.json';
  }

  Future<void> _loadFromLocal() async {
    try {
      final file = File(await _localPath);
      if (await file.exists()) {
        final content = await file.readAsString();
        setState(() {
          _files = json.decode(content);
          _isLoading = false;
        });
      }
    } catch (e) {
      debugPrint("$e");
    }
  }

  Future<void> _fetchFromApi() async {
    try {
      final files = await _apiService.getPatientPhotos(widget.patientId);
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

  void _toggleSelection(int index) {
    setState(() {
      if (_selectedIndices.contains(index)) {
        _selectedIndices.remove(index);
      } else {
        _selectedIndices.add(index);
      }
    });
  }

  Future<void> _renameFile() async {
    final files = _files.asMap().entries.where(
      (file) => _selectedIndices.contains(file.key),
    );
    final fileIds = files
        .map((x) => {"fileId": x.value['id'], "fileName": x.value['name']})
        .toList();
    final controller = TextEditingController(text: widget.patientName);

    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text("Give File Name"),
        content: TextField(controller: controller),
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
        for (var index in _selectedIndices) {
          await _apiService.deletePhoto(
            _files[index]['id'],
            widget.patientId,
            widget.patientId,
          );
        }
        _selectedIndices.clear();
        await _fetchFromApi();
      } catch (e) {
        setState(() => _isLoading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(
          _selectedIndices.isEmpty || _isLoading
              ? widget.patientName
              : "${_selectedIndices.length} selected",
        ),
        actions: [
          if (_selectedIndices.isNotEmpty && !_isLoading)
            IconButton(icon: const Icon(Icons.edit), onPressed: _renameFile),
          if (_selectedIndices.isNotEmpty && !_isLoading)
            IconButton(
              icon: const Icon(Icons.delete),
              onPressed: _deleteSelected,
            ),
          IconButton(icon: const Icon(Icons.refresh), onPressed: _fetchFromApi),
        ],
      ),
      body: _isLoading
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

                  return GestureDetector(
                    onLongPress: () => _toggleSelection(index),
                    onTap: () {
                      if (_selectedIndices.isNotEmpty) {
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
                        );
                      }
                    },
                    child: Stack(
                      fit: StackFit.expand,
                      children: [
                        CachedNetworkImage(
                          imageUrl:
                              file['thumbnailLink']?.replaceAll(
                                's220',
                                's400',
                              ) ??
                              '',
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
        title: Text('${_currentIndex + 1} / ${widget.files.length}'),
      ),
      body: PageView.builder(
        controller: _pageController,
        onPageChanged: (i) => setState(() => _currentIndex = i),
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
                ElevatedButton(
                  onPressed: () => launchUrl(
                    Uri.parse(file['webViewLink']),
                    mode: LaunchMode.externalApplication,
                  ),
                  child: const Text('View PDF'),
                ),
              ],
            );
          }

          return InteractiveViewer(
            child: CachedNetworkImage(
              imageUrl: 'https://drive.google.com/uc?id=${file['id']}',
              cacheKey: "${file['id']}_full",
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
