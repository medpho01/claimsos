import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hospital_app/env/env.dart';
import 'package:photo_manager/photo_manager.dart';

class UploadService {
  static final String baseUrl = Env.key;
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
      final formData = FormData();
      formData.fields.add(MapEntry('folderId', folderId));

      for (var i = 0; i < assets.length; i++) {
        final asset = assets[i];

        final file = await asset.file;
        if (file == null) {
          continue;
        }

        final bytes = await file.readAsBytes();
        final fileName = '${DateTime.now().millisecondsSinceEpoch}_$i.jpg';

        formData.files.add(
          MapEntry('files', MultipartFile.fromBytes(bytes, filename: fileName)),
        );
      }
      final response = await _dio.post('/uploads', data: formData);

      if (response.statusCode == 201) {
        return {'success': true, 'data': response.data};
      } else {
        return {'success': false, 'message': 'Upload failed'};
      }
    } catch (e) {
      return {'success': false, 'message': e.toString()};
    }
  }
}
