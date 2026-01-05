import 'package:envied/envied.dart';

part 'env.g.dart';

@Envied(path: '.env')
abstract class Env {
  @EnviedField(varName: 'BASE_ADDRESS', obfuscate: true)
  static final String key = _Env.key;
}
