import 'package:flutter/material.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:photo_manager_image_provider/photo_manager_image_provider.dart';

class FullScreenGallery extends StatefulWidget {
  final List<AssetEntity> allAssets;
  final int initialIndex;

  const FullScreenGallery({
    super.key,
    required this.allAssets,
    required this.initialIndex,
  });

  @override
  State<FullScreenGallery> createState() => _FullScreenGalleryState();
}

class _FullScreenGalleryState extends State<FullScreenGallery> {
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
        backgroundColor: Colors.black,
        title: Text("${_currentIndex + 1} of ${widget.allAssets.length}"),
        actions: [
          IconButton(
            icon: const Icon(Icons.info_outline),
            onPressed: () => _showMetadata(widget.allAssets[_currentIndex]),
          ),
        ],
      ),
      body: PageView.builder(
        controller: _pageController,
        itemCount: widget.allAssets.length,
        onPageChanged: (index) {
          setState(() => _currentIndex = index);
        },
        itemBuilder: (context, index) {
          final asset = widget.allAssets[index];
          return InteractiveViewer(
            clipBehavior: Clip.none,
            maxScale: 5.0,
            minScale: 1.0,
            child: Center(
              child: Hero(
                tag: asset.id,
                child: AssetEntityImage(
                  asset,
                  isOriginal: true, // High quality
                  fit: BoxFit.contain,
                  loadingBuilder: (context, child, progress) {
                    if (progress == null) return child;
                    return const Center(child: CircularProgressIndicator());
                  },
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  void _showMetadata(AssetEntity asset) {
    // Show the bottom sheet with GPS and Date info as created earlier
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }
}
