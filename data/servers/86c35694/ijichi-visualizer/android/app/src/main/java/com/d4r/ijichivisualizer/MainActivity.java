package com.d4r.ijichivisualizer;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(android.os.Bundle savedInstanceState) {
    registerPlugin(FfmpegExecPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
