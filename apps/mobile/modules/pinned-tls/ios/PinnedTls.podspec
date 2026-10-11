Pod::Spec.new do |s|
  s.name           = 'PinnedTls'
  s.version        = '1.0.0'
  s.summary        = 'HTTPS and WebSocket to plxd, trusting only its pinned certificate'
  s.author         = 'Parallax'
  s.homepage       = 'https://github.com/ryan-stoffel/parallax'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
