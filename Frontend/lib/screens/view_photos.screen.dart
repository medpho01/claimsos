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
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _initData();
  }

  Future<void> _initData() async {
    await _loadFromLocal();
    _fetchFromApi();
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
      debugPrint("Local load failed: $e");
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
      debugPrint("API fetch failed: $e");
      if (_files.isEmpty) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.patientName)),
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
                return GestureDetector(
                  onTap: () => Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) => FullScreenFileView(
                        files: _files,
                        initialIndex: index,
                      ),
                    ),
                  ),
                  child: CachedNetworkImage(
                    imageUrl:
                        file['thumbnailLink']?.replaceAll('s220', 's400') ?? '',
                    fit: BoxFit.cover,
                    cacheKey: file['id'],
                    memCacheWidth: 300,
                    placeholder: (context, url) =>
                        Container(color: Colors.grey.shade200),
                    errorWidget: (context, url, error) =>
                        const Icon(Icons.insert_drive_file),
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
        allowImplicitScrolling: true,
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
