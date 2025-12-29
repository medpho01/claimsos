import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:photo_manager_image_provider/photo_manager_image_provider.dart';
import 'package:camera/camera.dart';
import './../screens/camera.screen.dart';

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
  const MainGalleryScreen({super.key});

  @override
  State<MainGalleryScreen> createState() => _MainGalleryScreenState();
}

class _MainGalleryScreenState extends State<MainGalleryScreen> {
  List<AssetEntity> assets = [];
  Set<AssetEntity> selectedAssets = {};
  List<CameraDescription> cameras = [];

  @override
  void initState() {
    super.initState();
    _initializeCameras();
    _fetchAssets();

    // 1. Start listening to system changes
    PhotoManager.addChangeCallback(_onAssetsChanged);
    PhotoManager.startChangeNotify();
  }

  @override
  void dispose() {
    // 2. Stop listening to avoid memory leaks
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

  void _goToPatientSelection() {
    // Navigate to patient form
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(
          selectedAssets.isEmpty
              ? "Medpho Gallery"
              : "${selectedAssets.length} Selected",
        ),
        actions: selectedAssets.isNotEmpty
            ? [
                IconButton(
                  icon: const Icon(Icons.send, color: Colors.blue),
                  onPressed: _goToPatientSelection,
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
            : null,
      ),

      body: assets.isEmpty
          ? const Center(child: Text("No images found"))
          : GridView.builder(
              gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
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
                  onLongPress: () => setState(() => selectedAssets.add(asset)),
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
                          thumbnailSize: const ThumbnailSize.square(
                            200,
                          ), // Optimization
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
