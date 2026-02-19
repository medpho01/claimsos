import 'package:http/http.dart' as http;
// import 'package:flutter_pdfview/flutter_pdfview.dart';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pdfx/pdfx.dart';

class CachedPdfViewer extends StatefulWidget {
  final String fileId;
  final String url;

  const CachedPdfViewer({super.key, required this.fileId, required this.url});

  @override
  State<CachedPdfViewer> createState() => _CachedPdfViewerState();
}

class _CachedPdfViewerState extends State<CachedPdfViewer> {
  late PdfController _pdfController;
  bool _isReady = false;
  bool _hasError = false;

  @override
  void initState() {
    super.initState();
    _initPdf();
  }

  Future<void> _initPdf() async {
    try {
      final dir = await getApplicationDocumentsDirectory();
      final file = File('${dir.path}/${widget.fileId}.pdf');

      // 1. If the file DOES NOT exist locally, download it first!
      if (!await file.exists()) {
        final response = await http.get(Uri.parse(widget.url));
        if (response.statusCode == 200) {
          await file.writeAsBytes(response.bodyBytes);
        } else {
          throw Exception("Failed to download PDF");
        }
      }

      // 2. Open the file
      _pdfController = PdfController(document: PdfDocument.openFile(file.path));
      if (mounted) setState(() => _isReady = true);
    } catch (e) {
      debugPrint("PDF Load Error: $e");
      if (mounted) setState(() => _hasError = true);
    }
  }

  @override
  void dispose() {
    if (_isReady) _pdfController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_hasError) {
      return const Center(
        child: Text("Error loading PDF", style: TextStyle(color: Colors.white)),
      );
    }

    if (!_isReady) {
      return const Center(
        child: CircularProgressIndicator(color: Colors.white),
      );
    }

    return PdfView(
      controller: _pdfController,
      scrollDirection: Axis.vertical,
      pageSnapping: false,
      physics: const BouncingScrollPhysics(),
    );
  }
}
