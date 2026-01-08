import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hospital_app/env/env.dart';
import 'package:photo_manager/photo_manager.dart';

const Map<String, String> fieldNames = {
  'Discharge Slip': 'discharge_slip',
  'Investigations': 'investigations',
  'Treatment': 'treatment',
  'ICPs': 'icps',
  'Surgical Discharge Slip': 'surgical_discharge_slip',
  'OT Notes and Photos': 'ot_notes_and_photos',
  'Post Op Photos': 'post_op_photo',
  'Post Op Reports': 'post_op_reports',
  'Implant Invoice': 'implant_invoice',
};

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

  Future<Map<String, dynamic>> uploadImagesCategory(
    List<AssetEntity> assets,
    String patientId,
    String category,
  ) async {
    try {
      final formData = FormData();
      formData.fields.add(MapEntry('patientId', patientId));
      formData.fields.add(MapEntry('category', category));

      for (var i = 0; i < assets.length; i++) {
        final asset = assets[i];

        final file = await asset.file;
        if (file == null) {
          continue;
        }

        final bytes = await file.readAsBytes();
        final fileName = '${DateTime.now().millisecondsSinceEpoch}_$i.jpg';

        formData.files.add(
          MapEntry(
            fieldNames[category]!,
            MultipartFile.fromBytes(bytes, filename: fileName),
          ),
        );
      }
      final response = await _dio.post('/uploads/discharge', data: formData);

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
