from neo4j import GraphDatabase

# --- 配置信息 ---
# 请根据实际情况修改 URI、用户名和密码
URI = "bolt://localhost:7687"
AUTH = ("neo4j", "neo4j123456")

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