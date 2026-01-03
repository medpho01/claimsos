import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:photo_manager_image_provider/photo_manager_image_provider.dart';
import 'package:camera/camera.dart';
import './../screens/camera.screen.dart';
import './../services/auth_service.dart';
import './../services/upload_service.dart';
import './../screens/login.screen.dart';

class FullScreenPreview extends StatelessWidget {
  final AssetEntity asset;
  const FullScreenPreview({required this.asset, super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(),
      body: Center(
        child: AssetEntityImage(asset, isOriginal: false, fit: BoxFit.contain),
      ),
    );
  }
}

class MainGalleryScreen extends StatefulWidget {
  final int? patientId;
  final String? folderId;
  final String? patientName;
  final String? patientPhone;

  const MainGalleryScreen({
    this.patientId,
    this.folderId,
    this.patientName,
    this.patientPhone,
    super.key,
  });

  @override
  State<MainGalleryScreen> createState() => _MainGalleryScreenState();
}

class _MainGalleryScreenState extends State<MainGalleryScreen> {
  List<AssetEntity> assets = [];
  Set<AssetEntity> selectedAssets = {};
  List<CameraDescription> cameras = [];
  final UploadService _uploadService = UploadService();
  bool _isUploading = false;

  @override
  void initState() {
    super.initState();
    _initializeCameras();
    _fetchAssets();

    // Start listening to system changes
    PhotoManager.addChangeCallback(_onAssetsChanged);
    PhotoManager.startChangeNotify();
  }

  @override
  void dispose() {
    // Stop listening to avoid memory leaks
    PhotoManager.removeChangeCallback(_onAssetsChanged);
    PhotoManager.stopChangeNotify();
    super.dispose();
  }

  void _onAssetsChanged(MethodCall call) {
    _fetchAssets();
  }

  Future<void> _initializeCameras() async {
    try {
      cameras = await availableCameras();
    } catch (e) {
      debugPrint("Camera init error: $e");
    }
  }

  Future<void> _fetchAssets() async {
    final PermissionState ps = await PhotoManager.requestPermissionExtend();
    if (ps.isAuth) {
      final FilterOptionGroup filterOptionGroup = FilterOptionGroup(
        orders: [
          const OrderOption(type: OrderOptionType.createDate, asc: false),
        ],
      );

      // Fetch albums (AssetPathEntity)
      final List<AssetPathEntity> paths = await PhotoManager.getAssetPathList(
        onlyAll: true,
        type: RequestType.image,
        filterOption: filterOptionGroup,
      );

      if (paths.isEmpty) return;

      // Fetch assets from the "Recent" (index 0) album
      final int assetCount = await paths[0].assetCountAsync;
      final List<AssetEntity> entities = await paths[0].getAssetListRange(
        start: 0,
        end: assetCount > 500 ? 500 : assetCount,
      );

      if (mounted) {
        setState(() {
          assets = entities;
          // Optional: Prune selectedAssets if they no longer exist
          selectedAssets = selectedAssets
              .where((selected) => entities.any((e) => e.id == selected.id))
              .toSet();
        });
      }
    }
  }

  Future<void> _deleteSelectedPhotos() async {
    if (selectedAssets.isEmpty) return;

    try {
      final List<String> idList = selectedAssets.map((e) => e.id).toList();
      final List<String> result = await PhotoManager.editor.deleteWithIds(
        idList,
      );

      if (result.isNotEmpty) {
        setState(() {
          assets.removeWhere((asset) => result.contains(asset.id));
          selectedAssets.clear();
        });

        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text("${result.length} photos deleted")),
          );
        }
      }
    } catch (e) {
      debugPrint("Delete Error: $e");
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("Could not delete photos")),
        );
      }
    }
  }

  Future<void> _uploadSelectedPhotos() async {
    if (selectedAssets.isEmpty || widget.folderId == null) return;

    setState(() => _isUploading = true);

    try {
      final uploadResult = await _uploadService.uploadImages(
        selectedAssets.toList(),
        widget.folderId!,
      );

      if (!mounted) return;

      setState(() => _isUploading = false);

      if (uploadResult['success']) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              '${selectedAssets.length} photos uploaded successfully!',
            ),
            backgroundColor: Colors.green,
          ),
        );
        setState(() => selectedAssets.clear());
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Upload failed: ${uploadResult['message']}'),
            backgroundColor: Colors.red,
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        setState(() => _isUploading = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Error uploading photos: $e'),
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  Widget _buildPatientInfoBanner() {
    if (widget.patientName == null) return const SizedBox.shrink();

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: Colors.blue.shade50,
        border: Border(bottom: BorderSide(color: Colors.blue.shade200)),
      ),
      child: Row(
        children: [
          CircleAvatar(
            backgroundColor: Colors.blue.shade100,
            child: Text(
              widget.patientName!.isNotEmpty
                  ? widget.patientName![0].toUpperCase()
                  : '?',
              style: TextStyle(
                color: Colors.blue.shade700,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  widget.patientName!,
                  style: const TextStyle(
                    fontWeight: FontWeight.w600,
                    fontSize: 16,
                  ),
                ),
                if (widget.patientPhone != null)
                  Row(
                    children: [
                      Icon(Icons.phone, size: 14, color: Colors.grey.shade600),
                      const SizedBox(width: 4),
                      Text(
                        widget.patientPhone!,
                        style: TextStyle(
                          color: Colors.grey.shade600,
                          fontSize: 14,
                        ),
                      ),
                    ],
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(
          selectedAssets.isEmpty
              ? (widget.patientName != null
                    ? "Gallery - ${widget.patientName}"
                    : "Medpho Gallery")
              : "${selectedAssets.length} Selected",
        ),
        actions: selectedAssets.isNotEmpty
            ? [
                if (_isUploading)
                  const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 16),
                    child: SizedBox(
                      height: 20,
                      width: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    ),
                  )
                else if (widget.folderId != null)
                  IconButton(
                    icon: const Icon(Icons.cloud_upload, color: Colors.blue),
                    onPressed: _uploadSelectedPhotos,
                    tooltip: 'Upload to patient folder',
                  ),
                IconButton(
                  icon: const Icon(Icons.delete, color: Colors.red),
                  onPressed: () {
                    showDialog(
                      context: context,
                      builder: (ctx) => AlertDialog(
                        title: const Text("Delete Photos?"),
                        content: Text(
                          "Are you sure you want to delete ${selectedAssets.length} photos from your device?",
                        ),
                        actions: [
                          TextButton(
                            onPressed: () => Navigator.pop(ctx),
                            child: const Text("CANCEL"),
                          ),
                          TextButton(
                            onPressed: () {
                              Navigator.pop(ctx);
                              _deleteSelectedPhotos();
                            },
                            child: const Text(
                              "DELETE",
                              style: TextStyle(color: Colors.red),
                            ),
                          ),
                        ],
                      ),
                    );
                  },
                ),
                IconButton(
                  icon: const Icon(Icons.close),
                  onPressed: () => setState(() => selectedAssets.clear()),
                ),
              ]
            : [
                IconButton(
                  icon: const Icon(Icons.logout),
                  onPressed: () async {
                    await AuthService().logout();
                    if (context.mounted) {
                      Navigator.of(context).pushReplacement(
                        MaterialPageRoute(builder: (_) => const LoginScreen()),
                      );
                    }
                  },
                ),
              ],
      ),
      body: Column(
        children: [
          _buildPatientInfoBanner(),
          Expanded(
            child: assets.isEmpty
                ? const Center(child: Text("No images found"))
                : GridView.builder(
                    gridDelegate:
                        const SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: 4,
                          mainAxisSpacing: 1,
                          crossAxisSpacing: 1,
                          childAspectRatio: 1.0,
                        ),
                    itemCount: assets.length,
                    itemBuilder: (context, index) {
                      final asset = assets[index];
                      final isSelected = selectedAssets.contains(asset);

                      return GestureDetector(
                        onLongPress: () =>
                            setState(() => selectedAssets.add(asset)),
                        onTap: () {
                          if (selectedAssets.isNotEmpty) {
                            setState(
                              () => isSelected
                                  ? selectedAssets.remove(asset)
                                  : selectedAssets.add(asset),
                            );
                          } else {
                            // Navigate to preview
                            Navigator.push(
                              context,
                              MaterialPageRoute(
                                builder: (_) => FullScreenPreview(asset: asset),
                              ),
                            );
                          }
                        },
                        child: Stack(
                          children: [
                            Positioned.fill(
                              child: AssetEntityImage(
                                asset,
                                isOriginal: false,
                                thumbnailSize: const ThumbnailSize.square(200),
                                fit: BoxFit.cover,
                              ),
                            ),
                            if (isSelected)
                              Container(
                                color: Colors.blue.withOpacity(0.4),
                                child: const Center(
                                  child: Icon(
                                    Icons.check_circle,
                                    color: Colors.white,
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
      ),
      floatingActionButton: FloatingActionButton(
        child: const Icon(Icons.camera_alt),
        onPressed: () {
          if (cameras.isNotEmpty) {
            Navigator.push(
              context,
              MaterialPageRoute(builder: (c) => CameraScreen(cameras: cameras)),
            );
          } else {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text("Camera not initialized or found")),
            );
          }
        },
      ),
    );
  }
}
