import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:photo_manager_image_provider/photo_manager_image_provider.dart';
import 'package:camera/camera.dart';
import './../screens/camera.screen.dart';
import './../services/auth_service.dart';
import './../services/upload_service.dart';
import './../screens/login.screen.dart';
import './../widgets/upload_progress_dialog.dart';
import './imagePreview.screen.dart';

class CategoryUploadScreen extends StatefulWidget {
  final String? patientId;
  final String? folderId;
  final String? patientName;
  final String? patientPhone;
  final String? field;

  const CategoryUploadScreen({
    this.patientId,
    this.folderId,
    this.patientName,
    this.patientPhone,
    this.field,
    super.key,
  });

  @override
  State<CategoryUploadScreen> createState() => _MainGalleryScreenState();
}

class _MainGalleryScreenState extends State<CategoryUploadScreen> {
  List<AssetEntity> assets = [];
  Set<AssetEntity> selectedAssets = {};
  List<CameraDescription> cameras = [];
  final UploadService _uploadService = UploadService();
  final bool _isUploading = false;

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
            SnackBar(
              content: Text("${result.length} photos deleted"),
              behavior: SnackBarBehavior.floating,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(10),
              ),
            ),
          );
        }
      }
    } catch (e) {
      debugPrint("Delete Error: $e");
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: const Text("Could not delete photos"),
            behavior: SnackBarBehavior.floating,
            backgroundColor: Colors.red.shade600,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(10),
            ),
          ),
        );
      }
    }
  }

  Future<void> _uploadSelectedPhotos() async {
    if (selectedAssets.isEmpty || widget.folderId == null) return;

    final assetsToUpload = selectedAssets.toList();

    // Show upload progress dialog
    final result = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => UploadProgressDialog(
        assets: assetsToUpload,
        patientName: widget.patientName ?? 'Unknown Patient',
        onUpload: () => _uploadService.uploadImagesCategory(
          assetsToUpload,
          widget.patientId!,
          widget.field!,
        ),
      ),
    );

    if (result == true && mounted) {
      // Upload was successful - clear selection
      setState(() => selectedAssets.clear());
    }
    if (mounted) Navigator.of(context).pop();
  }

  void _selectAll() {
    setState(() {
      selectedAssets = Set.from(assets);
    });
  }

  void _deselectAll() {
    setState(() {
      selectedAssets.clear();
    });
  }

  Widget _buildPatientInfoBanner() {
    if (widget.patientName == null) return const SizedBox.shrink();

    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: theme.colorScheme.primary.withOpacity(isDark ? 0.2 : 0.1),
        border: Border(bottom: BorderSide(color: theme.dividerColor)),
      ),
      child: Row(
        children: [
          CircleAvatar(
            backgroundColor: theme.colorScheme.primary.withOpacity(
              isDark ? 0.3 : 0.2,
            ),
            child: Text(
              widget.patientName!.isNotEmpty
                  ? widget.patientName![0].toUpperCase()
                  : '?',
              style: TextStyle(
                color: theme.colorScheme.primary,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
          const SizedBox(width: 14),
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
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSelectionBar() {
    if (selectedAssets.isEmpty) return const SizedBox.shrink();

    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      decoration: BoxDecoration(
        color: theme.colorScheme.primary.withOpacity(isDark ? 0.2 : 0.1),
        border: Border(bottom: BorderSide(color: theme.dividerColor)),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: theme.colorScheme.primary,
              borderRadius: BorderRadius.circular(20),
            ),
            child: Text(
              '${selectedAssets.length} selected',
              style: TextStyle(
                color: theme.colorScheme.onPrimary,
                fontWeight: FontWeight.w600,
                fontSize: 13,
              ),
            ),
          ),
          const Spacer(),
          _buildActionChip(
            icon: Icons.select_all,
            label: 'All',
            onTap: _selectAll,
          ),
          const SizedBox(width: 8),
          _buildActionChip(
            icon: Icons.deselect,
            label: 'None',
            onTap: _deselectAll,
          ),
          const SizedBox(width: 8),
          _buildActionChip(
            icon: Icons.delete_outline,
            label: 'Delete',
            onTap: _showDeleteDialog,
            isDestructive: true,
          ),
        ],
      ),
    );
  }

  Widget _buildActionChip({
    required IconData icon,
    required String label,
    required VoidCallback onTap,
    bool isDestructive = false,
  }) {
    final theme = Theme.of(context);
    final chipColor = isDestructive ? Colors.red : theme.colorScheme.primary;

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: chipColor.withOpacity(0.1),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: chipColor.withOpacity(0.3)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 16, color: chipColor),
            const SizedBox(width: 4),
            Text(
              label,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w500,
                color: chipColor,
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _showDeleteDialog() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: Colors.red.shade50,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Icon(Icons.delete_forever, color: Colors.red.shade600),
            ),
            const SizedBox(width: 12),
            const Text("Delete Photos?"),
          ],
        ),
        content: Text(
          "Are you sure you want to delete ${selectedAssets.length} photo${selectedAssets.length != 1 ? 's' : ''} from your device? This action cannot be undone.",
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(
              "Cancel",
              style: TextStyle(color: Colors.grey.shade600),
            ),
          ),
          ElevatedButton(
            onPressed: () {
              Navigator.pop(ctx);
              _deleteSelectedPhotos();
            },
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.red.shade600,
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(8),
              ),
            ),
            child: const Text("Delete"),
          ),
        ],
      ),
    );
  }

  Widget _buildEmptyState() {
    final theme = Theme.of(context);

    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            padding: const EdgeInsets.all(24),
            decoration: BoxDecoration(
              color: theme.colorScheme.surfaceContainerHighest,
              shape: BoxShape.circle,
            ),
            child: Icon(
              Icons.photo_library_outlined,
              size: 64,
              color: theme.hintColor,
            ),
          ),
          const SizedBox(height: 24),
          Text(
            'No photos yet',
            style: TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.w600,
              color: theme.textTheme.bodyLarge?.color,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Tap the camera button to capture photos',
            style: TextStyle(fontSize: 14, color: theme.hintColor),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final bool hasSelection = selectedAssets.isNotEmpty;
    final bool canUpload =
        hasSelection && widget.folderId != null && !_isUploading;

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              hasSelection ? "${selectedAssets.length} Selected" : "Gallery",
              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 18),
            ),
            if (widget.patientName != null && !hasSelection)
              Text(
                widget.patientName!,
                style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
              ),
          ],
        ),
        actions: [
          if (hasSelection)
            IconButton(
              icon: const Icon(Icons.close),
              onPressed: _deselectAll,
              tooltip: 'Clear selection',
            )
          else
            IconButton(
              icon: const Icon(Icons.logout_rounded),
              onPressed: () async {
                await AuthService().logout();
                if (context.mounted) {
                  Navigator.of(context).pushReplacement(
                    MaterialPageRoute(builder: (_) => const LoginScreen()),
                  );
                }
              },
              tooltip: 'Logout',
            ),
        ],
      ),
      body: Column(
        children: [
          _buildPatientInfoBanner(),
          _buildSelectionBar(),
          Expanded(
            child: assets.isEmpty
                ? _buildEmptyState()
                : GridView.builder(
                    padding: const EdgeInsets.all(2),
                    gridDelegate:
                        const SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: 3,
                          mainAxisSpacing: 2,
                          crossAxisSpacing: 2,
                          childAspectRatio: 1.0,
                        ),
                    itemCount: assets.length,
                    itemBuilder: (context, index) {
                      final asset = assets[index];
                      final isSelected = selectedAssets.contains(asset);
                      final selectionIndex = selectedAssets.toList().indexOf(
                        asset,
                      );

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
                            Navigator.push(
                              context,
                              MaterialPageRoute(
                                builder: (_) => FullScreenGallery(
                                  allAssets: assets,
                                  initialIndex: index,
                                ),
                              ),
                            );
                          }
                        },
                        child: AnimatedContainer(
                          duration: const Duration(milliseconds: 200),
                          decoration: BoxDecoration(
                            border: isSelected
                                ? Border.all(
                                    color: Colors.blue.shade400,
                                    width: 3,
                                  )
                                : null,
                          ),
                          child: Stack(
                            fit: StackFit.expand,
                            children: [
                              AssetEntityImage(
                                asset,
                                isOriginal: false,
                                thumbnailSize: const ThumbnailSize.square(300),
                                fit: BoxFit.cover,
                              ),
                              if (isSelected)
                                Container(color: Colors.blue.withOpacity(0.3)),
                              if (isSelected)
                                Positioned(
                                  top: 6,
                                  right: 6,
                                  child: Container(
                                    width: 24,
                                    height: 24,
                                    decoration: BoxDecoration(
                                      color: Colors.blue.shade600,
                                      shape: BoxShape.circle,
                                      boxShadow: [
                                        BoxShadow(
                                          color: Colors.black.withOpacity(0.3),
                                          blurRadius: 4,
                                        ),
                                      ],
                                    ),
                                    child: Center(
                                      child: selectionIndex >= 0
                                          ? Text(
                                              '${selectionIndex + 1}',
                                              style: const TextStyle(
                                                color: Colors.white,
                                                fontSize: 11,
                                                fontWeight: FontWeight.bold,
                                              ),
                                            )
                                          : const Icon(
                                              Icons.check,
                                              color: Colors.white,
                                              size: 14,
                                            ),
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
      floatingActionButton: Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          // Camera button
          FloatingActionButton(
            heroTag: 'camera',
            backgroundColor: Colors.grey.shade700,
            child: const Icon(Icons.camera_alt, color: Colors.white),
            onPressed: () {
              if (cameras.isNotEmpty) {
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (c) =>
                        CameraScreen(cameras: cameras, from: "Gallery"),
                  ),
                );
              } else {
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: const Text("Camera not initialized or found"),
                    behavior: SnackBarBehavior.floating,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                );
              }
            },
          ),
          // Send/Upload button - only show when photos are selected
          if (canUpload) ...[
            const SizedBox(width: 16),
            FloatingActionButton.extended(
              heroTag: 'upload',
              backgroundColor: Colors.green.shade600,
              icon: const Icon(Icons.send, color: Colors.white),
              label: Text(
                'Send ${selectedAssets.length}',
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w600,
                ),
              ),
              onPressed: _uploadSelectedPhotos,
            ),
          ],
          // Show uploading indicator
          if (_isUploading) ...[
            const SizedBox(width: 16),
            FloatingActionButton.extended(
              heroTag: 'uploading',
              backgroundColor: Colors.blue.shade600,
              onPressed: null,
              icon: const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                ),
              ),
              label: const Text(
                'Uploading...',
                style: TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
