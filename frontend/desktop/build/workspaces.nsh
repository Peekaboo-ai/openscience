!macro customRemoveFiles
  SetOutPath $TEMP
  ${if} ${isUpdated}
    ; 旧版默认逐文件 Rename 到 C 盘临时目录，安装在其他磁盘时必然失败。
    ; 在同一父目录原子暂存旧程序；改名失败则保留原安装并停止升级。
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    StrCpy $R1 "$INSTDIR.__previous-$0"
    ${if} ${FileExists} "$R1"
      Abort "A previous installation backup already exists: $R1"
    ${endif}
    ClearErrors
    Rename "$INSTDIR" "$R1"
    ${if} ${Errors}
      Abort "The existing application is busy. Close OpenScience Workspaces and retry."
    ${endif}
    RMDir /r "$R1"
    ${if} ${Errors}
      ; 备份清理失败不触碰其他路径，留下明确位置供后续人工处理。
      DetailPrint "Old application files remain at $R1"
      ClearErrors
    ${endif}
  ${else}
    RMDir /r "$INSTDIR"
  ${endif}
!macroend
