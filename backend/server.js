// 加载环境变量
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const CryptoJS = require('crypto-js');
const AWS = require('aws-sdk');

// 导入训练相关路由
const trainingRoutes = require('./training-routes');

const app = express();
const port = 3000;

// 配置 AWS
AWS.config.update({
  region: process.env.AWS_REGION || 'ap-northeast-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

// 创建S3客户端
const s3 = new AWS.S3();
const BUCKET_NAME = process.env.S3_BUCKET || 'cp10bucket';

// 中间件
app.use(cors());
app.use(express.json());

// 配置文件上传 - 使用内存存储而不是磁盘存储
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 限制5MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('只能上传图片文件！'));
    }
  }
});

// 添加静态文件服务 - 仍然保留用于本地开发
app.use('/uploads', express.static('uploads'));

// 数据库连接配置
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '1234',  // 替换为你的实际密码
  database: 'cloud_storage',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
}).promise();

// 添加解密函数（在创建 app 之后的位置）
const decryptPassword = (encryptedPassword) => {
  const secretKey = process.env.CRYPTO_SECRET || 'your-secure-key-2024'; // 从环境变量获取密钥
  try {
    const bytes = CryptoJS.AES.decrypt(encryptedPassword, secretKey);
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch (error) {
    console.error('密码解密错误:', error);
    return null; // 解密失败
  }
};

// 登录路由
app.post('/api/auth/login', async (req, res) => {
  const { username, password, isEncrypted } = req.body;
  
  // 解密密码（如果已加密）
  const actualPassword = isEncrypted ? decryptPassword(password) : password;
  
  // 如果解密失败
  if (isEncrypted && !actualPassword) {
    return res.status(400).json({ error: '密码解密失败' });
  }

  try {
    // 查询用户
    const [users] = await pool.query(
      'SELECT * FROM users WHERE username = ?',
      [username]
    );

    if (users.length === 0) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const user = users[0];
    const validPassword = await bcrypt.compare(actualPassword, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    // 生成JWT令牌
    const token = jwt.sign(
      { id: user.id, username: user.username },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );

    res.json({ token, username: user.username });
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ error: '登录失败' });
  }
});

// 注册路由
app.post('/api/auth/register', async (req, res) => {
  const { username, password, isEncrypted } = req.body;
  
  // 解密密码（如果已加密）
  const actualPassword = isEncrypted ? decryptPassword(password) : password;
  
  // 如果解密失败
  if (isEncrypted && !actualPassword) {
    return res.status(400).json({ error: '密码解密失败' });
  }

  try {
    // 检查用户名是否已存在
    const [existingUsers] = await pool.query(
      'SELECT id FROM users WHERE username = ?',
      [username]
    );

    if (existingUsers.length > 0) {
      return res.status(400).json({ error: '用户名已存在' });
    }

    // 加密密码
    const passwordHash = await bcrypt.hash(actualPassword, 10);

    // 创建新用户
    const [result] = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      [username, passwordHash]
    );

    // 生成JWT令牌
    const token = jwt.sign(
      { id: result.insertId, username },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );

    res.json({ token, username });
  } catch (error) {
    console.error('注册错误:', error);
    res.status(500).json({ error: '注册失败' });
  }
});

// 验证 token 的中间件
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: '未提供认证令牌' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
    if (err) {
      return res.status(403).json({ error: '无效的认证令牌' });
    }
    req.user = user;
    next();
  });
};

// 图片上传路由
app.post('/api/images/upload', authenticateToken, upload.array('images', 100), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '没有文件被上传' });
    }

    const files = req.files;
    const userId = req.user.id;
    let folderId = null;
    
    // 如果没有指定文件夹，使用根文件夹
    if (!req.body.folder_id || req.body.folder_id === '') {
      const [rootFolder] = await pool.query(
        'SELECT id FROM folders WHERE user_id = ? AND is_root = TRUE',
        [userId]
      );
      if (rootFolder.length > 0) {
        folderId = rootFolder[0].id;
      }
    } else if (!isNaN(parseInt(req.body.folder_id))) {
      folderId = parseInt(req.body.folder_id);
    }
    
    // 验证文件夹存在性（如果不是根文件夹）
    if (folderId !== null) {
      const [folder] = await pool.query(
        'SELECT id FROM folders WHERE id = ? AND user_id = ?',
        [folderId, userId]
      );
      
      if (folder.length === 0) {
        return res.status(400).json({ error: '指定的文件夹不存在' });
      }
    }
    
    // 上传到S3并存储元数据
    const uploadPromises = files.map(file => {
      const timestamp = Date.now();
      const randomString = Math.round(Math.random() * 1E9);
      const key = `users/${userId}/images/${timestamp}-${randomString}${path.extname(file.originalname)}`;
      
      const params = {
        Bucket: BUCKET_NAME,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        ACL: 'public-read'  // 添加公共读取权限
      };
      
      return s3.upload(params).promise()
        .then(data => ({
          name: file.originalname,
          file_path: data.Key, // S3的路径
          s3_url: data.Location, // 完整S3 URL
          user_id: userId,
          folder_id: folderId,
          size: file.size,
          mime_type: file.mimetype
        }));
    });
    
    try {
      // 等待所有文件上传完成
      const uploadedFiles = await Promise.all(uploadPromises);
      
      // 准备SQL插入数据
      const values = uploadedFiles.map(file => [
        file.name,
        file.file_path,
        userId,
        folderId,
        file.size,
        file.mime_type,
        file.s3_url // 添加S3 URL字段
      ]);

      // 修改SQL语句，添加s3_url字段
      const sql = `INSERT INTO images (name, file_path, user_id, folder_id, size, mime_type, s3_url) 
                   VALUES ${values.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`;

      console.log('SQL:', sql);  // 添加日志
      console.log('Values:', values.flat());  // 添加日志

      await pool.query(sql, values.flat());

      res.json({ 
        message: '上传成功',
        count: files.length,
        files: uploadedFiles.map(f => ({
          name: f.name,
          size: f.size,
          url: f.s3_url
        }))
      });
    } catch (dbError) {
      // 如果数据库插入失败，尝试从S3删除已上传的文件
      console.error('数据库错误，尝试清理S3文件:', dbError);
      
      // 尝试从S3删除已上传的文件
      uploadedFiles.forEach(file => {
        const params = {
          Bucket: BUCKET_NAME,
          Key: file.file_path
        };
        s3.deleteObject(params).promise()
          .catch(err => console.error('删除S3文件失败:', err));
      });
      
      throw dbError;
    }
  } catch (error) {
    console.error('上传错误:', error);
    res.status(500).json({ 
      error: '上传失败',
      message: error.message 
    });
  }
});

// 获取图片列表
app.get('/api/images', authenticateToken, async (req, res) => {
  try {
    const { folder_id } = req.query;
    const userId = req.user.id;

    let sql = 'SELECT * FROM images WHERE user_id = ?';
    const params = [userId];

    if (folder_id) {
      sql += ' AND folder_id = ?';
      params.push(folder_id);
    }

    sql += ' ORDER BY created_at DESC';

    const [images] = await pool.query(sql, params);

    // 使用S3预签名URL或本地URL
    const imagesWithUrls = await Promise.all(images.map(async image => {
      let url;
      if (image.s3_url) {
        // 检查是否是S3路径，如果是，则生成预签名URL（有效期为2小时）
        const params = {
          Bucket: BUCKET_NAME,
          Key: image.file_path,
          Expires: 7200  // 2小时，单位为秒
        };
        try {
          url = await s3.getSignedUrlPromise('getObject', params);
        } catch (error) {
          console.error('生成预签名URL失败:', error);
          url = image.s3_url; // 如果生成失败，使用原始S3 URL
        }
      } else {
        url = `http://57.181.23.46/${image.file_path}`;
      }
      
      return {
        ...image,
        url
      };
    }));

    res.json(imagesWithUrls);
  } catch (error) {
    console.error('获取图片列表错误:', error);
    res.status(500).json({ error: '获取图片列表失败' });
  }
});

// 删除图片
app.delete('/api/images/:id', authenticateToken, async (req, res) => {
  try {
    const [image] = await pool.query(
      'SELECT file_path FROM images WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (image.length === 0) {
      return res.status(404).json({ error: '图片不存在' });
    }

    // 从S3删除文件
    const params = {
      Bucket: BUCKET_NAME,
      Key: image[0].file_path
    };

    try {
      await s3.deleteObject(params).promise();
    } catch (s3Error) {
      console.error('从S3删除文件失败:', s3Error);
      // 继续执行，即使S3删除失败也要从数据库删除记录
    }

    // 删除数据库记录
    await pool.query(
      'DELETE FROM images WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    res.json({ message: '删除成功' });
  } catch (error) {
    console.error('删除图片错误:', error);
    res.status(500).json({ error: '删除失败' });
  }
});

// 创建文件夹
app.post('/api/folders', authenticateToken, async (req, res) => {
  try {
    const { name, parent_id } = req.body;
    const userId = req.user.id;

    // 如果没有指定父文件夹，使用根文件夹作为父文件夹
    if (!parent_id) {
      const [rootFolder] = await pool.query(
        'SELECT id FROM folders WHERE user_id = ? AND is_root = TRUE',
        [userId]
      );
      if (rootFolder.length > 0) {
        const [result] = await pool.query(
          'INSERT INTO folders (name, parent_id, user_id) VALUES (?, ?, ?)',
          [name, rootFolder[0].id, userId]
        );
        return res.json({
          id: result.insertId,
          name,
          parent_id: rootFolder[0].id
        });
      }
    }

    const [result] = await pool.query(
      'INSERT INTO folders (name, parent_id, user_id) VALUES (?, ?, ?)',
      [name, parent_id || null, userId]
    );

    res.json({
      id: result.insertId,
      name,
      parent_id: parent_id || null
    });
  } catch (error) {
    console.error('创建文件夹错误:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ error: '该文件夹名称已存在' });
    } else {
      res.status(500).json({ error: '创建文件夹失败' });
    }
  }
});

// 获取文件夹列表
app.get('/api/folders', authenticateToken, async (req, res) => {
  try {
    const { parent_id, tree } = req.query;
    const userId = req.user.id;

    // 如果请求文件夹树
    if (tree) {
      const [rootFolder] = await pool.query(
        'SELECT * FROM folders WHERE user_id = ? AND is_root = TRUE',
        [userId]
      );
      
      if (rootFolder.length > 0) {
        // 获取所有文件夹
        const [allFolders] = await pool.query(
          'SELECT * FROM folders WHERE user_id = ? ORDER BY name',
          [userId]
        );
        
        // 构建文件夹树
        const buildTree = (parentId) => {
          return allFolders
            .filter(f => f.parent_id === parentId)
            .map(folder => ({
              id: folder.id,
              name: folder.name,
              children: buildTree(folder.id)
            }));
        };
        
        // 从根文件夹开始构建树
        const tree = {
          id: rootFolder[0].id,
          name: '根目录',
          children: buildTree(rootFolder[0].id)
        };
        
        return res.json([tree]);
      }
    }

    // 如果没有指定 parent_id，获取根文件夹
    if (parent_id === undefined || parent_id === '') {
      const [rootFolder] = await pool.query(
        'SELECT * FROM folders WHERE user_id = ? AND is_root = TRUE',
        [userId]
      );
      if (rootFolder.length > 0) {
        const [subFolders] = await pool.query(
          'SELECT * FROM folders WHERE user_id = ? AND parent_id = ? ORDER BY name',
          [userId, rootFolder[0].id]
        );
        return res.json(subFolders);
      }
    }

    // 如果指定了 parent_id，获取该文件夹下的子文件夹
    const [folders] = await pool.query(
      'SELECT * FROM folders WHERE user_id = ? AND parent_id = ? ORDER BY name',
      [userId, parseInt(parent_id)]
    );

    res.json(folders);
  } catch (error) {
    console.error('获取文件夹列表错误:', error);
    res.status(500).json({ error: '获取文件夹列表失败' });
  }
});

// 删除文件夹
app.delete('/api/folders/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // 首先检查文件夹是否存在且属于当前用户
    const [folder] = await pool.query(
      'SELECT * FROM folders WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (folder.length === 0) {
      return res.status(404).json({ error: '文件夹不存在' });
    }

    // 获取文件夹中的所有图片
    const [images] = await pool.query(
      'SELECT file_path FROM images WHERE folder_id = ?',
      [id]
    );

    // 删除S3中的图片文件
    const deletePromises = images.map(image => {
      const params = {
        Bucket: BUCKET_NAME,
        Key: image.file_path
      };
      return s3.deleteObject(params).promise()
        .catch(err => {
          console.error(`删除S3文件 ${image.file_path} 失败:`, err);
          // 继续处理其他文件
        });
    });
    
    try {
      await Promise.allSettled(deletePromises);
    } catch (s3Error) {
      console.error('删除S3文件时发生错误:', s3Error);
      // 继续执行数据库操作
    }

    // 删除文件夹（级联删除会自动处理子文件夹和图片的数据库记录）
    await pool.query(
      'DELETE FROM folders WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    res.json({ message: '文件夹删除成功' });
  } catch (error) {
    console.error('删除文件夹错误:', error);
    res.status(500).json({ error: '删除文件夹失败' });
  }
});

// 重命名文件夹
app.put('/api/folders/:id/rename', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    const userId = req.user.id;

    // 检查文件夹是否存在且属于当前用户
    const [folder] = await pool.query(
      'SELECT * FROM folders WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (folder.length === 0) {
      return res.status(404).json({ error: '文件夹不存在' });
    }

    // 检查新名称在同一父文件夹下是否已存在
    const [existingFolder] = await pool.query(
      'SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ? AND id != ?',
      [name, folder[0].parent_id, userId, id]
    );

    if (existingFolder.length > 0) {
      return res.status(400).json({ error: '该名称已存在' });
    }

    // 更新文件夹名称
    await pool.query(
      'UPDATE folders SET name = ? WHERE id = ? AND user_id = ?',
      [name, id, userId]
    );

    res.json({ message: '重命名成功', name });
  } catch (error) {
    console.error('重命名文件夹错误:', error);
    res.status(500).json({ error: '重命名失败' });
  }
});

// 移动文件夹
app.put('/api/folders/:id/move', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { target_folder_id } = req.body;
    const userId = req.user.id;

    // 检查源文件夹是否存在且属于当前用户
    const [sourceFolder] = await pool.query(
      'SELECT * FROM folders WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (sourceFolder.length === 0) {
      return res.status(404).json({ error: '源文件夹不存在' });
    }

    // 如果目标文件夹ID不为空，检查目标文件夹是否存在
    if (target_folder_id) {
      const [targetFolder] = await pool.query(
        'SELECT * FROM folders WHERE id = ? AND user_id = ?',
        [target_folder_id, userId]
      );

      if (targetFolder.length === 0) {
        return res.status(404).json({ error: '目标文件夹不存在' });
      }

      // 检查是否在目标文件夹下已存在同名文件夹
      const [existingFolder] = await pool.query(
        'SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ? AND id != ?',
        [sourceFolder[0].name, target_folder_id, userId, id]
      );

      if (existingFolder.length > 0) {
        return res.status(400).json({ error: '目标文件夹下已存在同名文件夹' });
      }
    }

    // 更新文件夹的父文件夹ID
    await pool.query(
      'UPDATE folders SET parent_id = ? WHERE id = ? AND user_id = ?',
      [target_folder_id || null, id, userId]
    );

    res.json({ message: '移动成功' });
  } catch (error) {
    console.error('移动文件夹错误:', error);
    res.status(500).json({ error: '移动失败' });
  }
});

// 移动图片
app.put('/api/images/:id/move', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { target_folder_id } = req.body;
    const userId = req.user.id;

    // 检查图片是否存在且属于当前用户
    const [image] = await pool.query(
      'SELECT * FROM images WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (image.length === 0) {
      return res.status(404).json({ error: '图片不存在' });
    }

    // 如果目标文件夹ID不为空，检查目标文件夹是否存在
    if (target_folder_id) {
      const [targetFolder] = await pool.query(
        'SELECT * FROM folders WHERE id = ? AND user_id = ?',
        [target_folder_id, userId]
      );

      if (targetFolder.length === 0) {
        return res.status(404).json({ error: '目标文件夹不存在' });
      }

      // 检查是否在目标文件夹下已存在同名图片
      const [existingImage] = await pool.query(
        'SELECT id FROM images WHERE name = ? AND folder_id = ? AND user_id = ? AND id != ?',
        [image[0].name, target_folder_id, userId, id]
      );

      if (existingImage.length > 0) {
        return res.status(400).json({ error: '目标文件夹下已存在同名图片' });
      }
    }

    // 更新图片的文件夹ID
    await pool.query(
      'UPDATE images SET folder_id = ? WHERE id = ? AND user_id = ?',
      [target_folder_id || null, id, userId]
    );

    res.json({ message: '移动成功' });
  } catch (error) {
    console.error('移动图片错误:', error);
    res.status(500).json({ error: '移动失败' });
  }
});

// CLIP 搜索路由（更新以支持S3路径）
app.post('/api/images/search', authenticateToken, async (req, res) => {
  try {
    const { query, folder_ids, limit = 100, min_score = 0.155 } = req.body;
    const userId = req.user.id;

    // 获取用户的图片
    let sql = 'SELECT * FROM images WHERE user_id = ?';
    const params = [userId];

    if (folder_ids && folder_ids.length > 0) {
      sql += ' AND folder_id IN (?)';
      params.push(folder_ids);
    }

    sql += ' LIMIT ?';
    params.push(parseInt(limit));

    console.log('查询语句:', sql);
    console.log('参数:', params);

    const [images] = await pool.query(sql, params);
    console.log(`找到 ${images.length} 张图片`);

    if (images.length === 0) {
      return res.json([]);
    }

    // 如果图片存储在S3上，我们需要下载临时副本供CLIP处理
    const imagePaths = await Promise.all(images.map(async (img) => {
      // 检查是否是S3路径
      if (img.s3_url) {
        try {
          // 创建uploads目录（如果不存在）
          if (!fs.existsSync('uploads')) {
            fs.mkdirSync('uploads');
          }
          
          // 创建临时文件路径
          const tempPath = path.join('uploads', path.basename(img.file_path));
          
          // 从S3下载文件
          const params = {
            Bucket: BUCKET_NAME,
            Key: img.file_path
          };
          
          const data = await s3.getObject(params).promise();
          fs.writeFileSync(tempPath, data.Body);
          
          // 返回临时文件路径
          return tempPath;
        } catch (error) {
          console.error(`处理S3图片 ${img.file_path} 时出错:`, error);
          return null;
        }
      } else {
        // 如果不是S3路径，使用原始文件路径
        return img.file_path;
      }
    }));

    // 过滤掉无效路径
    const validImagePaths = imagePaths.filter(path => path !== null);

    // 设置超时
    const clipRequestTimeout = setTimeout(() => {
      console.error('CLIP 请求超时');
      res.status(504).json({ error: 'CLIP 服务请求超时' });
    }, 50000);

    // 调用 Python CLIP 服务
    try {
      const clipResponse = await fetch('http://57.181.23.46:5000/api/clip/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          images: validImagePaths,
          min_score: min_score
        }),
      });

      clearTimeout(clipRequestTimeout); // 清除超时

      if (!clipResponse.ok) {
        const errorText = await clipResponse.text();
        throw new Error(`CLIP 服务响应错误: ${errorText}`);
      }

      const clipResults = await clipResponse.json();

      // 将结果与图片信息合并并过滤低相似度结果
      const results = clipResults
        .filter(result => result.score >= min_score)
        .map(result => {
          // 查找匹配的图片，考虑可能使用临时路径的情况
          const image = images.find(img => 
            img.file_path === result.path || 
            path.basename(img.file_path) === path.basename(result.path)
          );
          if (!image) return null;
          return {
            ...image,
            url: image.s3_url || `http://57.181.23.46/${image.file_path}`,
            score: result.score,
          };
        }).filter(item => item !== null);

      // 清理临时文件
      imagePaths.forEach(tempPath => {
        if (tempPath && tempPath.startsWith('uploads/') && fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      });

      res.json(results);
    } catch (error) {
      clearTimeout(clipRequestTimeout);
      throw error;
    }
  } catch (error) {
    console.error('CLIP 搜索错误:', error);
    res.status(500).json({ error: 'CLIP 搜索失败: ' + error.message });
  }
});

// 获取文件夹树
app.get('/api/folders/tree', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const buildTree = async (parentId) => {
      const [folders] = await pool.query(
        'SELECT * FROM folders WHERE user_id = ? AND parent_id = ?',
        [userId, parentId]
      );


      const folderTree = await Promise.all(folders.map(async (folder) => {
        const children = await buildTree(folder.id);
        return {
          ...folder,
          children
        };
      }));

      return folderTree;
    };

    const rootFolders = await buildTree(1); // 获取根文件夹
    res.json(rootFolders);
  } 
  catch (error) {
    console.error('获取文件夹树错误:', error);
    res.status(500).json({ error: '获取文件夹树失败' });
  }
});

// 获取文件夹内所有图片路径
app.post('/api/folders/images', authenticateToken, async (req, res) => {
  try {
    const { folderIds } = req.body;
    const userId = req.user.id;
    
    if (!folderIds || !Array.isArray(folderIds) || folderIds.length === 0) {
      return res.status(400).json({ error: '请提供有效的文件夹ID列表' });
    }
    
    // 验证文件夹所属
    const [validFolders] = await pool.query(
      'SELECT id FROM folders WHERE id IN (?) AND user_id = ?',
      [folderIds, userId]
    );
    
    if (validFolders.length === 0) {
      return res.status(404).json({ error: '找不到有效的文件夹' });
    }
    
    // 获取文件夹中所有图片的路径
    const [images] = await pool.query(
      `SELECT i.id, i.file_path as path, i.name
       FROM images i
       JOIN folders f ON i.folder_id = f.id
       WHERE f.id IN (?) AND f.user_id = ?`,
      [folderIds, userId]
    );
    
    res.json(images);
    
  } catch (error) {
    console.error('获取文件夹图片错误:', error);
    res.status(500).json({ error: '获取图片列表失败' });
  }
});

// 获取图片元数据
app.post('/api/images/metadata', authenticateToken, async (req, res) => {
  try {
    const { paths } = req.body;
    const userId = req.user.id;
    
    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: '请提供有效的图片路径列表' });
    }
    
    // 获取图片元数据
    const [images] = await pool.query(
      `SELECT i.id, i.name, i.file_path as path, i.file_url as url, 
              i.folder_id, f.name as folder_name
       FROM images i
       JOIN folders f ON i.folder_id = f.id
       WHERE i.file_path IN (?) AND f.user_id = ?`,
      [paths, userId]
    );
    
    // 处理路径可能的格式差异
    const normalizedPaths = paths.map(p => p.replace(/\\/g, '/'));
    const imageMap = new Map();
    
    // 首先用路径精确匹配查找
    images.forEach(img => {
      const normalizedPath = img.path.replace(/\\/g, '/');
      imageMap.set(normalizedPath, img);
    });
    
    // 对于找不到的路径，尝试部分匹配
    const result = normalizedPaths.map(path => {
      // 精确匹配
      if (imageMap.has(path)) {
        return imageMap.get(path);
      }
      
      // 部分匹配（路径的末尾部分）
      for (const [imgPath, imgData] of imageMap.entries()) {
        if (path.endsWith(imgPath) || imgPath.endsWith(path)) {
          return imgData;
        }
      }
      
      // 构造基本URL（没有元数据时）
      return { 
        path, 
        url: `http://57.181.23.46/${path}`, 
        name: path.split('/').pop() 
      };
    });
    
    res.json(result);
    
  } catch (error) {
    console.error('获取图片元数据错误:', error);
    res.status(500).json({ error: '获取图片元数据失败' });
  }
});

// 获取已部署的CLIP模型列表
app.get('/api/models/deployed', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // 获取用户已部署的模型列表
    const [models] = await pool.query(
      `SELECT id, name, endpoint_name, status
       FROM clip_models
       WHERE user_id = ?
       AND endpoint_name IS NOT NULL
       AND status = 'ready'
       ORDER BY created_at DESC`,
      [userId]
    );
    
    // 添加默认CLIP模型
    const deployedModels = [
      {
        id: '1',
        name: 'CLIP默认模型',
        endpoint_name: null,
        description: '默认的CLIP ViT-L/14模型',
        is_default: true
      },
      ...models.map(model => ({
        id: model.id,
        name: model.name,
        endpoint_name: model.endpoint_name,
        description: `基于用户数据微调的CLIP模型`,
        is_default: false
      }))
    ];
    
    res.json(deployedModels);
  } catch (error) {
    console.error('获取已部署模型列表错误:', error);
    res.status(500).json({ error: '获取模型列表失败' });
  }
});

// 注册训练相关路由
app.use('/api/training', trainingRoutes);

app.listen(port, () => {
  console.log(`服务器运行在 http://57.181.23.46:${port}`);
}); 