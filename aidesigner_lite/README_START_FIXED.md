# AI Designer Lite 一键启动修复说明

## 这版解决的问题

- `start_all.bat` 打开后闪退。
- 旧 Python `.venv` 带有其他电脑路径，导致换电脑后启动异常。
- 图片服务改为纯 Node 本地服务，不再依赖 Python、pip、venv。
- 启动脚本会停留窗口并写入 `start_all.log`，不再一闪而过。

## 启动方式

双击：

```bat
start_all.bat
```

正常会打开两个窗口：

1. `AIDesigner Image Server 18080`
2. `AIDesigner Backend 3000`

浏览器打开：

```text
http://localhost:3000/dashboard.html
http://localhost:3000/image.html
```

管理员账号：

```text
admin@localhost
AdminLocal@2026
```

## 如果还是报错

双击：

```bat
start_debug.bat
```

这个窗口不会自动关闭，会把后端错误直接显示出来。

## 关于本机硬件

你的电脑是 Intel Iris Xe 核显，16GB 内存，不适合直接本地跑 Stable Diffusion WebUI 这种重模型。
这版内置的是 CPU-safe 本地图片服务，用来保证工程的一键启动和图片生成链路可用。

后续如果要接真实大模型，建议保留当前本地接口不变，把 `local-image-server/app-node.js`
替换成真正的模型服务适配器，或者让后端转接到远程 GPU/云模型接口。
