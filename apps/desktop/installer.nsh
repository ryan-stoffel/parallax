; Included in the NSIS installer (electron-builder.yml). Explorer and the taskbar cache an exe's icon
; by its path, so an update that changes the icon would keep showing the old one until told.
!macro customInstall
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
