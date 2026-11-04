Pod::Spec.new do |s|
  s.name = 'CindyJPush'
  s.version = '0.1.0'
  s.summary = 'Optional personal iOS push transport.'
  s.description = s.summary
  s.license = { :type => 'Apache-2.0' }
  s.author = 'Cindy'
  s.homepage = 'https://github.com/makecindy/cindy'
  s.source = { git: s.homepage }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'JPush', '6.2.7'
  s.source_files = '**/*.{h,m,swift}'
  s.public_header_files = 'CindyJPushSDK.h'
end
