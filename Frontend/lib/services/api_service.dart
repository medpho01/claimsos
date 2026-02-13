import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hospital_app/env/env.dart';
import 'package:hospital_app/main.dart';

class ApiService {
  static final String baseUrl = Env.key;
  final Dio _dio;
  final Dio _refreshDio = Dio(BaseOptions(baseUrl: Env.key));
  final FlutterSecureStorage _storage = const FlutterSecureStorage();

  ApiService()
    : _dio = Dio(
        BaseOptions(
          baseUrl: baseUrl,
          connectTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 10),
          headers: {'Content-Type': 'application/json'},
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
        onError: (error, handler) async {
          if (error.response?.statusCode == 401 &&
              error.requestOptions.path != '/auth/refreshAccessToken') {
            final success = await _refreshToken();

            if (success) {
              final newToken = await _storage.read(key: 'accessToken');
              final requestOptions = error.requestOptions;

              final opts = Options(
                method: requestOptions.method,
                headers: requestOptions.headers
                  ..['Authorization'] = 'Bearer $newToken',
              );

              try {
                final response = await _dio.request(
                  requestOptions.path,
                  options: opts,
                  data: requestOptions.data,
                  queryParameters: requestOptions.queryParameters,
                );
                return handler.resolve(response);
              } catch (e) {
                return handler.next(error);
              }
            } else {
              await _storage.delete(key: 'accessToken');
              await _storage.delete(key: 'refreshToken');
              navigatorKey.currentState?.pushNamedAndRemoveUntil(
                '/login',
                (Route<dynamic> route) => false,
              );
            }
          }
          return handler.next(error);
        },
      ),
    );
  }

  Future<bool> _refreshToken() async {
    try {
      final refreshToken = await _storage.read(key: 'refreshToken');
      if (refreshToken == null) return false;

      final response = await _refreshDio.post(
        '/v1/auth/refreshAccessToken',
        data: {'refreshToken': refreshToken},
      );

      if (response.statusCode == 200) {
        final data = response.data['data'];
        await _storage.write(key: 'accessToken', value: data['accessToken']);
        await _storage.write(key: 'refreshToken', value: data['refreshToken']);
        return true;
      }
    } catch (e) {
      await _storage.deleteAll();
    }
    return false;
  }

  Future<Response> post(String path, {Map<String, dynamic>? data}) async {
    return await _dio.post(path, data: data);
  }

  Future<Response> get(
    String path, {
    Map<String, dynamic>? queryParameters,
  }) async {
    return await _dio.get(path, queryParameters: queryParameters);
  }

  Future<Response> patch(String path, {Map<String, dynamic>? data}) async {
    return await _dio.patch(path, data: data);
  }

  Future<Response> delete(String path) async {
    return await _dio.delete(path);
  }

  Future<Response> deleteWithBody(
    String path, {
    Map<String, dynamic>? data,
  }) async {
    return await _dio.delete(path, data: data);
  }

  Future<List<dynamic>> getPatientPhotos(String patientId) async {
    final response = await _dio.get(
      '/v1/uploads/dishargePhotos/$patientId/all',
    );
    return (response.statusCode == 200)
        ? response.data['data'] as List<dynamic>
        : [];
  }

  Future<List<dynamic>> getDischargePhotos(
    String patientId,
    String category,
  ) async {
    final response = await _dio.get(
      '/v1/uploads/dishargePhotos/$patientId/$category',
    );
    return (response.statusCode == 200)
        ? response.data['data'] as List<dynamic>
        : [];
  }

  Future<bool> deletePhoto(
    String fileId,
    String patientId,
    String folderId,
  ) async {
    final response = await _dio.delete(
      '/v1/uploads/$fileId',
      data: {'patientId': patientId, 'folderId': folderId},
    );
    return response.statusCode == 200;
  }

  Future<bool> renameFile(
    List<dynamic> files,
    String patientId,
    String customName,
  ) async {
    final response = await _dio.post(
      '/v1/uploads/renameFileHospital',
      data: {'patientId': patientId, 'files': files, "customName": customName},
    );
    return response.statusCode == 200;
  }
}
