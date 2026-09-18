import os
import sys

from neo4j import GraphDatabase

# 凭据统一从项目根目录 .env.local 读取（见 scripts/env.py），不再硬编码
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env import get_password, get_user  # noqa: E402

# --- 配置信息 ---
URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
AUTH = (get_user(), get_password())

def test_connection():
    try:
        print("🔌 正在尝试连接...")
        
        # 创建驱动实例
        driver = GraphDatabase.driver(URI, auth=AUTH)
        
        # 验证连接 (verify_connectivity 是新版推荐方法)
        driver.verify_connectivity()
        
        print("✅ 连接成功！Neo4j 数据库已就绪。")
        
        # 关闭连接
        driver.close()
        
    except Exception as e:
        print(f"❌ 连接失败: {e}")
        print("\n💡 请检查:")
        print("   1. Neo4j 服务是否已启动？")
        print("   2. 端口 (默认 7687) 是否正确？")
        print("   3. 用户名或密码是否错误？")

if __name__ == "__main__":
    test_connection()