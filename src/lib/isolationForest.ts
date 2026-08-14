/**
 * Isolation Forest 异常检测算法
 * 
 * 原理：异常点更容易被"孤立"。通过随机选择特征和分割点构建二叉树，
 * 异常点由于稀疏且偏离主流分布，往往在树的浅层就被隔离出来。
 * 
 * 异常分数公式：s(x, n) = 2^(-E(h(x))/c(n))
 * - h(x): 样本 x 在森林中的平均路径长度
 * - c(n): 给定样本数 n 的平均路径长度（归一化因子）
 */

export interface IsolationForestOptions {
  /** 树的数量，默认 100 */
  nTrees?: number;
  /** 每棵树的采样数，默认 256 */
  sampleSize?: number;
  /** 异常阈值，默认 0.6 */
  threshold?: number;
}

interface IsolationTree {
  root: TreeNode | null;
  height: number;
}

interface TreeNode {
  featureIndex: number;
  splitValue: number;
  left: TreeNode | null;
  right: TreeNode | null;
  size: number;
}

export class IsolationForest {
  private trees: IsolationTree[] = [];
  private nTrees: number;
  private sampleSize: number;
  private threshold: number;
  private nFeatures: number = 0;

  constructor(options: IsolationForestOptions = {}) {
    this.nTrees = options.nTrees ?? 100;
    this.sampleSize = options.sampleSize ?? 256;
    this.threshold = options.threshold ?? 0.6;
  }

  /**
   * 训练模型
   * @param data 特征矩阵，每行是一个样本，每列是一个特征
   */
  fit(data: number[][]): void {
    this.nFeatures = data[0].length;
    this.trees = [];

    const n = data.length;
    const actualSampleSize = Math.min(this.sampleSize, n);

    for (let i = 0; i < this.nTrees; i++) {
      // 随机采样
      const sample = this.randomSample(data, actualSampleSize);
      const tree = this.buildTree(sample, 0, Math.ceil(Math.log2(actualSampleSize)));
      this.trees.push(tree);
    }
  }

  /**
   * 预测异常分数
   * @param data 特征矩阵
   * @returns 每个样本的异常分数 [0, 1]，越接近 1 越异常
   */
  predict(data: number[][]): number[] {
    const n = this.sampleSize;
    const c = this.averagePathLength(n);

    return data.map((point) => {
      // 计算在所有树中的平均路径长度
      const avgPathLength = this.trees.reduce((sum, tree) => {
        return sum + this.pathLength(point, tree.root, 0);
      }, 0) / this.trees.length;

      // 异常分数：s(x, n) = 2^(-E(h(x))/c(n))
      return Math.pow(2, -avgPathLength / c);
    });
  }

  /**
   * 预测并返回异常标记
   */
  predictWithLabels(data: number[][]): { score: number; isAnomaly: boolean }[] {
    const scores = this.predict(data);
    return scores.map((score) => ({
      score,
      isAnomaly: score >= this.threshold,
    }));
  }

  private buildTree(data: number[][], height: number, maxHeight: number): IsolationTree {
    const root = this.buildNode(data, height, maxHeight);
    return { root, height: maxHeight };
  }

  private buildNode(data: number[][], height: number, maxHeight: number): TreeNode | null {
    if (height >= maxHeight || data.length <= 1) {
      return {
        featureIndex: -1,
        splitValue: 0,
        left: null,
        right: null,
        size: data.length,
      };
    }

    // 随机选择特征
    const featureIndex = Math.floor(Math.random() * this.nFeatures);

    // 获取该特征的最小值和最大值
    const values = data.map((row) => row[featureIndex]);
    const min = Math.min(...values);
    const max = Math.max(...values);

    if (min === max) {
      return {
        featureIndex: -1,
        splitValue: 0,
        left: null,
        right: null,
        size: data.length,
      };
    }

    // 随机选择分割值
    const splitValue = min + Math.random() * (max - min);

    // 分割数据
    const left = data.filter((row) => row[featureIndex] < splitValue);
    const right = data.filter((row) => row[featureIndex] >= splitValue);

    return {
      featureIndex,
      splitValue,
      left: this.buildNode(left, height + 1, maxHeight),
      right: this.buildNode(right, height + 1, maxHeight),
      size: data.length,
    };
  }

  private pathLength(point: number[], node: TreeNode | null, depth: number): number {
    if (!node || node.featureIndex === -1) {
      // 到达叶子节点，加上未展开部分的平均路径长度
      const size = node?.size ?? 1;
      return depth + this.averagePathLength(size);
    }

    if (point[node.featureIndex] < node.splitValue) {
      return this.pathLength(point, node.left, depth + 1);
    } else {
      return this.pathLength(point, node.right, depth + 1);
    }
  }

  /**
   * 计算给定样本数 n 的平均路径长度（用于归一化）
   * c(n) = 2*H(n-1) - 2*(n-1)/n
   * H(i) = ln(i) + 0.5772156649 (欧拉常数)
   */
  private averagePathLength(n: number): number {
    if (n <= 1) return 0;
    if (n === 2) return 1;

    const harmonic = Math.log(n - 1) + 0.5772156649;
    return 2 * harmonic - 2 * (n - 1) / n;
  }

  private randomSample(data: number[][], size: number): number[][] {
    const shuffled = [...data].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, size);
  }
}

/**
 * 特征提取：从节点数据中提取用于异常检测的特征
 */
export function extractAnomalyFeatures(nodes: Array<{
  degree: number;
  in_degree: number;
  out_degree: number;
  port_count: number;
  community_size: number;
}>): number[][] {
  return nodes.map((node) => {
    // 特征 1: 度中心性（连接数）
    const degree = node.degree;

    // 特征 2: 入度/出度比率（流量不对称性）
    const total = node.in_degree + node.out_degree;
    const inOutRatio = total > 0 ? node.in_degree / total : 0.5;

    // 特征 3: 端口多样性
    const portCount = node.port_count;

    // 特征 4: 社区大小（小社区中的节点更可能异常）
    const communitySize = node.community_size;

    // 特征 5: 度/社区大小比率（在社区内的相对重要性）
    const degreeInCommunity = communitySize > 0 ? degree / communitySize : 0;

    return [degree, inOutRatio, portCount, communitySize, degreeInCommunity];
  });
}

/**
 * 异常等级划分
 */
export function getAnomalyLevel(score: number): 'Critical' | 'High' | 'Medium' | 'Low' {
  if (score >= 0.75) return 'Critical';
  if (score >= 0.6) return 'High';
  if (score >= 0.45) return 'Medium';
  return 'Low';
}
