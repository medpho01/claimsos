import 'dart:io';
import 'package:flutter/material.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:photo_manager_image_provider/photo_manager_image_provider.dart';

enum UploadStatus { pending, uploading, success, failed }

class UploadProgressDialog extends StatefulWidget {
  final List<AssetEntity> assets;
  final List<File>? files;
  final String patientName;
  final Future<Map<String, dynamic>> Function() onUpload;

  const UploadProgressDialog({
    this.assets = const [],
    this.files, // New parameter
    required this.patientName,
    required this.onUpload,
    super.key,
  });

  @override
  State<UploadProgressDialog> createState() => _UploadProgressDialogState();
}

class _UploadProgressDialogState extends State<UploadProgressDialog>
    with TickerProviderStateMixin {
  late AnimationController _progressController;
  late AnimationController _pulseController;
  late AnimationController _successController;
  late ScrollController _scrollController;

  UploadStatus _overallStatus = UploadStatus.uploading;
  int _currentIndex = 0;
  String? _errorMessage;

  int get _totalItems => (widget.files?.length ?? 0) + widget.assets.length;

  bool get _isPdfMode => (widget.files?.isNotEmpty ?? false);

  static const double _thumbnailSize = 52.0;
  static const double _thumbnailSpacing = 6.0;

  @override
  void initState() {
    super.initState();

    _scrollController = ScrollController();

    _progressController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2000),
    );

    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1500),
    )..repeat(reverse: true);

    _successController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 600),
    );

    _startUpload();
  }

  @override
  void dispose() {
    _progressController.dispose();
    _pulseController.dispose();
    _successController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _scrollToCurrentImage() {
    if (!_scrollController.hasClients) return;

    final itemWidth = _thumbnailSize + _thumbnailSpacing;
    final viewportWidth = _scrollController.position.viewportDimension;
    final targetScroll =
        (_currentIndex * itemWidth) - (viewportWidth / 2) + (itemWidth / 2);

    final clampedScroll = targetScroll.clamp(
      0.0,
      _scrollController.position.maxScrollExtent,
    );

    _scrollController.animateTo(
      clampedScroll,
      duration: const Duration(milliseconds: 400),
      curve: Curves.easeOutCubic,
    );
  }

  Future<void> _startUpload() async {
    await Future.delayed(const Duration(milliseconds: 100));

    _progressController.animateTo(
      0.95,
      duration: Duration(milliseconds: _totalItems * 400 + 2000),
      curve: Curves.linear,
    );

    for (int i = 0; i < _totalItems; i++) {
      if (!mounted) return;
      setState(() => _currentIndex = i);
      _scrollToCurrentImage();
      await Future.delayed(const Duration(milliseconds: 350));
    }

    try {
      final result = await widget.onUpload();

      if (!mounted) return;

      await _progressController.animateTo(
        1.0,
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeOut,
      );

      if (!mounted) return;

      if (result['success'] == true) {
        setState(() => _overallStatus = UploadStatus.success);
        _pulseController.stop();
        await _successController.forward();
        await Future.delayed(const Duration(milliseconds: 1200));
        if (mounted) Navigator.pop(context, true);
      } else {
        setState(() {
          _overallStatus = UploadStatus.failed;
          _errorMessage = result['message'] ?? 'Upload failed';
        });
        _pulseController.stop();
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _overallStatus = UploadStatus.failed;
        _errorMessage = e.toString();
      });
      _pulseController.stop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return PopScope(
      canPop: _overallStatus != UploadStatus.uploading,
      child: Dialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
        elevation: 16,
        child: Container(
          padding: const EdgeInsets.all(28),
          constraints: const BoxConstraints(maxWidth: 340),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              _buildHeader(theme),
              const SizedBox(height: 24),
              _buildImageCarousel(theme),
              const SizedBox(height: 24),
              _buildProgressSection(theme),
              const SizedBox(height: 20),
              _buildStatusMessage(theme),
              if (_overallStatus == UploadStatus.failed) ...[
                const SizedBox(height: 20),
                _buildCloseButton(theme),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildHeader(ThemeData theme) {
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 400),
      switchInCurve: Curves.easeOutBack,
      switchOutCurve: Curves.easeIn,
      child: _overallStatus == UploadStatus.success
          ? _buildSuccessHeader(theme)
          : _overallStatus == UploadStatus.failed
          ? _buildFailedHeader(theme)
          : _buildUploadingHeader(theme),
    );
  }

  Widget _buildUploadingHeader(ThemeData theme) {
    final icon = _isPdfMode
        ? Icons.file_present_rounded
        : Icons.cloud_upload_rounded;
    final title = _isPdfMode ? 'Sending Documents' : 'Sending Photos';

    return Column(
      key: const ValueKey('uploading'),
      children: [
        AnimatedBuilder(
          animation: _pulseController,
          builder: (context, child) {
            return Transform.scale(
              scale: 1.0 + (_pulseController.value * 0.08),
              child: Container(
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: [
                      theme.colorScheme.primary.withAlpha(40),
                      theme.colorScheme.primary.withAlpha(20),
                    ],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                  shape: BoxShape.circle,
                ),
                child: Icon(icon, size: 44, color: theme.colorScheme.primary),
              ),
            );
          },
        ),
        const SizedBox(height: 16),
        Text(
          title,
          style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 6),
        Text(
          widget.patientName,
          style: TextStyle(fontSize: 14, color: theme.hintColor),
        ),
      ],
    );
  }

  Widget _buildSuccessHeader(ThemeData theme) {
    final text = _isPdfMode ? 'Documents sent!' : 'Photos sent!';

    return Column(
      key: const ValueKey('success'),
      children: [
        ScaleTransition(
          scale: CurvedAnimation(
            parent: _successController,
            curve: Curves.elasticOut,
          ),
          child: Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              color: Colors.green.withAlpha(30),
              shape: BoxShape.circle,
            ),
            child: const Icon(
              Icons.check_circle_rounded,
              size: 44,
              color: Colors.green,
            ),
          ),
        ),
        const SizedBox(height: 16),
        Text(
          text,
          style: const TextStyle(
            fontSize: 20,
            fontWeight: FontWeight.bold,
            color: Colors.green,
          ),
        ),
      ],
    );
  }

  Widget _buildFailedHeader(ThemeData theme) {
    return Column(
      key: const ValueKey('failed'),
      children: [
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color: Colors.red.withAlpha(30),
            shape: BoxShape.circle,
          ),
          child: const Icon(
            Icons.error_outline_rounded,
            size: 44,
            color: Colors.red,
          ),
        ),
        const SizedBox(height: 16),
        const Text(
          'Upload Failed. Try Again!',
          style: TextStyle(
            fontSize: 20,
            fontWeight: FontWeight.bold,
            color: Colors.red,
          ),
        ),
      ],
    );
  }

  Widget _buildImageCarousel(ThemeData theme) {
    return SizedBox(
      height: _thumbnailSize + 8,
      child: ShaderMask(
        shaderCallback: (Rect bounds) {
          return LinearGradient(
            colors: [
              Colors.transparent,
              Colors.white,
              Colors.white,
              Colors.transparent,
            ],
            stops: const [0.0, 0.1, 0.9, 1.0],
            begin: Alignment.centerLeft,
            end: Alignment.centerRight,
          ).createShader(bounds);
        },
        blendMode: BlendMode.dstIn,
        child: ListView.builder(
          controller: _scrollController,
          scrollDirection: Axis.horizontal,
          physics: const BouncingScrollPhysics(),
          padding: const EdgeInsets.symmetric(horizontal: 20),
          itemCount: _totalItems,
          itemBuilder: (context, index) {
            return Padding(
              padding: EdgeInsets.only(
                left: index == 0 ? 0 : _thumbnailSpacing / 2,
                right: index == _totalItems - 1 ? 0 : _thumbnailSpacing / 2,
              ),
              // Pass generic 'index' to build logic
              child: _buildThumbnail(index, theme),
            );
          },
        ),
      ),
    );
  }

  Widget _buildThumbnail(int index, ThemeData theme) {
    final isProcessed =
        index < _currentIndex || _overallStatus == UploadStatus.success;
    final isCurrent =
        index == _currentIndex && _overallStatus == UploadStatus.uploading;
    final isPending =
        index > _currentIndex && _overallStatus == UploadStatus.uploading;
    Widget content;
    if (widget.files != null && widget.files!.isNotEmpty) {
      // PDF/File Mode
      content = Container(
        color: Colors.orange.shade50,
        child: Center(
          child: Icon(
            Icons.picture_as_pdf,
            color: Colors.orange.shade700,
            size: 24,
          ),
        ),
      );
    } else {
      // Image Asset Mode
      content = AssetEntityImage(
        widget.assets[index],
        isOriginal: false,
        thumbnailSize: const ThumbnailSize.square(120),
        fit: BoxFit.cover,
      );
    }

    return AnimatedContainer(
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeOut,
      width: _thumbnailSize,
      height: _thumbnailSize,
      transform: Matrix4.identity()..scale(isCurrent ? 1.1 : 1.0),
      transformAlignment: Alignment.center,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(12),
        border: isCurrent
            ? Border.all(color: theme.colorScheme.primary, width: 2.5)
            : null,
        boxShadow: isCurrent
            ? [
                BoxShadow(
                  color: theme.colorScheme.primary.withAlpha(80),
                  blurRadius: 12,
                  spreadRadius: 2,
                ),
              ]
            : null,
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(10),
        child: Stack(
          fit: StackFit.expand,
          children: [
            // CONTENT (Image or PDF Icon)
            AnimatedOpacity(
              opacity: isPending ? 0.5 : 1.0,
              duration: const Duration(milliseconds: 200),
              child: content,
            ),

            // Success overlay
            AnimatedOpacity(
              opacity: isProcessed ? 1.0 : 0.0,
              duration: const Duration(milliseconds: 300),
              child: Container(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: [
                      Colors.green.withAlpha(200),
                      Colors.green.withAlpha(160),
                    ],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                ),
                child: const Icon(
                  Icons.check_rounded,
                  color: Colors.white,
                  size: 24,
                ),
              ),
            ),

            // Current processing overlay
            if (isCurrent)
              AnimatedBuilder(
                animation: _pulseController,
                builder: (context, child) {
                  return Container(
                    color: theme.colorScheme.primary.withAlpha(
                      (30 + (_pulseController.value * 40)).toInt(),
                    ),
                    child: Center(
                      child: SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2.5,
                          valueColor: const AlwaysStoppedAnimation<Color>(
                            Colors.white,
                          ),
                        ),
                      ),
                    ),
                  );
                },
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildProgressSection(ThemeData theme) {
    Color progressColor;
    if (_overallStatus == UploadStatus.failed) {
      progressColor = Colors.red;
    } else if (_overallStatus == UploadStatus.success) {
      progressColor = Colors.green;
    } else {
      progressColor = theme.colorScheme.primary;
    }

    return Column(
      children: [
        AnimatedBuilder(
          animation: _progressController,
          builder: (context, child) {
            return Column(
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: LinearProgressIndicator(
                    value: _progressController.value,
                    minHeight: 10,
                    backgroundColor: theme.colorScheme.surfaceContainerHighest,
                    valueColor: AlwaysStoppedAnimation<Color>(progressColor),
                  ),
                ),
                const SizedBox(height: 10),
                Text(
                  '${(_progressController.value * 100).toInt()}%',
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: theme.hintColor,
                  ),
                ),
              ],
            );
          },
        ),
      ],
    );
  }

  Widget _buildStatusMessage(ThemeData theme) {
    String message;
    Color? color;

    switch (_overallStatus) {
      case UploadStatus.uploading:
      case UploadStatus.pending:
        final progress = _currentIndex + 1;
        final type = _isPdfMode ? 'document' : 'image';
        message = 'Uploading $type $progress of $_totalItems...';
        break;
      case UploadStatus.success:
        final type = _isPdfMode ? 'documents' : 'photos';
        message = 'All $_totalItems $type saved to cloud';
        color = Colors.green;
        break;
      case UploadStatus.failed:
        message = _errorMessage ?? 'Something went wrong';
        color = Colors.red;
        break;
    }

    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 300),
      child: Text(
        message,
        key: ValueKey(message),
        textAlign: TextAlign.center,
        style: TextStyle(
          color: color ?? theme.hintColor,
          fontSize: 13,
          height: 1.4,
        ),
      ),
    );
  }

  Widget _buildCloseButton(ThemeData theme) {
    return SizedBox(
      width: double.infinity,
      child: ElevatedButton(
        onPressed: () => Navigator.pop(context, false),
        style: ElevatedButton.styleFrom(
          backgroundColor: theme.colorScheme.primary,
          foregroundColor: theme.colorScheme.onPrimary,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
          padding: const EdgeInsets.symmetric(vertical: 14),
          elevation: 0,
        ),
        child: const Text(
          'Close',
          style: TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
        ),
      ),
    );
  }
}
