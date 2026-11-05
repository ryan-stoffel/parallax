Pod::Spec.new do |s|
  s.name           = 'ThreadStatus'
  s.version        = '1.0.0'
  s.summary        = 'The threads the widget and the Live Activity show'
  s.author         = 'Parallax'
  s.homepage       = 'https://github.com/ryan-stoffel/parallax'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
