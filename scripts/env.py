# -*- coding: utf-8 -*-
"""统一凭据加载器（供 scripts/ 下的 Python CLI 使用）

密码只保存在项目根目录的 .env.local（已被 .gitignore 忽略），
源码里不再出现任何硬编码密码。零第三方依赖。

用法：
    from env import get_password, get_user, get_uri
    AUTH = (get_user(), get_password())
"""
import os

_ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env.local")


def load_env_local(path=_ENV_PATH):
    """把 .env.local 里的键值注入 os.environ（不覆盖已存在的环境变量）。"""
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip())
    except OSError:
        pass


def get_user():
    load_env_local()
    return os.environ.get("NEO4J_USER", "neo4j")


def get_password(required=True):
    """required=False 时允许为空（例如 --dry-run 不连库的场合）。"""
    load_env_local()
    password = os.environ.get("NEO4J_PASSWORD", "")
    if not password and required:
        raise SystemExit(
            "[env] 缺少 NEO4J_PASSWORD：请在项目根目录 .env.local 中配置 "
            "NEO4J_PASSWORD=<你的密码>，或通过 --password 传入"
        )
    return password


def get_uri(default="bolt://127.0.0.1:7687"):
    load_env_local()
    return os.environ.get("NEO4J_URI", default)
