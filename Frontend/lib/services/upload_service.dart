import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:photo_manager/photo_manager.dart';

class UploadService {
  static const String baseUrl = 'http://192.168.1.8:8000/api/v1';
  final Dio _dio;
  final FlutterSecureStorage _storage = const FlutterSecureStorage();

  UploadService()
    : _dio = Dio(
        BaseOptions(
          baseUrl: baseUrl,
          connectTimeout: const Duration(seconds: 60),
          receiveTimeout: const Duration(seconds: 60),
        ),
      ) {
    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          final token = await _storage.read(key: 'accessToken');
          if (token != null) {
            options.headers['Authorization'] = 'Bearer $token';
          }
          return handler.next(options);
        },
      ),
    );
  }

  Future<Map<String, dynamic>> uploadImages(
    List<AssetEntity> assets,
    String folderId,
  ) async {
    try {
      print('[UPLOAD] Starting upload of ${assets.length} images...');

      final formData = FormData();
      formData.fields.add(MapEntry('folderId', folderId));

      // Convert AssetEntity to files
      for (var i = 0; i < assets.length; i++) {
        final asset = assets[i];
        print('  Processing image ${i + 1}/${assets.length}...');

        final file = await asset.file;
        if (file == null) {
          print('  Could not get file for asset ${i + 1}');
          continue;
        }

        final bytes = await file.readAsBytes();
        final fileName = '${DateTime.now().millisecondsSinceEpoch}_$i.jpg';

        formData.files.add(
          MapEntry('files', MultipartFile.fromBytes(bytes, filename: fileName)),
        );

        print('  Added to upload queue: $fileName');
      }

      print('[UPLOAD] Uploading ${formData.files.length} files to server...');
      final response = await _dio.post('/uploads', data: formData);

      if (response.statusCode == 201) {
        print('[UPLOAD] Upload complete!');
        return {'success': true, 'data': response.data};
      } else {
        print('[UPLOAD] Upload failed with status: ${response.statusCode}');
        return {'success': false, 'message': 'Upload failed'};
      }
    } catch (e) {
      print('[UPLOAD] Error: $e');
      return {'success': false, 'message': e.toString()};
    }
  }
}
