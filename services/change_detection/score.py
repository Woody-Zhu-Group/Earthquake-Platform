import numpy as np
import torch
import torch.nn as nn
from scipy.spatial.distance import cdist
from scipy.stats import gaussian_kde
from torch.utils.data import TensorDataset, DataLoader
import os

# Fitting of the score model
# TODO: Refine structure of the score model, e.g., add more options for the network architecture, etc.
# Different activation functions, different number of layers, different number of hidden units, etc.
# Devise a debugging strategy for the score model, e.g., check the output of the score model, check the loss function, check the gradients, etc.
# See if the learned score model is reasonable, e.g., check the output of the score model, check the loss function, check the gradients, etc.
# Goodness of fit of the score model, e.g., check the output of the score model, check the loss function, check the gradients, etc.

# Visualizations of the loss function
# Check if the gradient makes sense according to the distribution
# Can technically happen in close form
# Can see those things in case there is a mismatch
# 

class ScoreModel(torch.nn.Module):
    '''
    score model for general point process
    lightweight implementation assuming no history dependence (i.e., marginal)
    '''
    def __init__(self, ndim, radius=0.1, ff_layers=[64], rn_layers=2, rn_hidden=64, use_transform=False):
        '''
        Args:
        - ndim:     dimension of the data (e.g., ndim = 3+mark_dim)
        - radius:   neighborhood radius for localization
        - use_transform: whether to DSM in transformed space
        '''
        super().__init__()
        self.radius = radius
        self.ndim   = ndim
        # parameters and networks
        self.base  = torch.nn.Parameter(torch.zeros(ndim)).requires_grad_(False)   # [ ndim ] torch
        self.ff = self.ff = nn.Sequential(
            nn.Linear(rn_hidden + ndim, ff_layers[0]),
            nn.SiLU(),
            *[
                m
                for i in range(len(ff_layers)-1)
                for m in (
                    nn.Linear(ff_layers[i], ff_layers[i+1]),
                    nn.SiLU()
                )
            ],
            nn.Linear(ff_layers[-1], ndim)
        )
        self.rn = nn.LSTM(
            input_size  = ndim,
            hidden_size = rn_hidden,
            num_layers  = rn_layers,
            batch_first = False
        )
        self.use_transform = use_transform

        # Initialize self.ff to output zero for any input
        for layer in self.ff:
            if isinstance(layer, nn.Linear):
                nn.init.zeros_(layer.weight)  # Set weights to zero
                nn.init.zeros_(layer.bias)    # Set biases to zero

    def fit(self, data, batch_size=256, n_epochs=1000, lr=1e-3, sigma=0.1, save_folder=None, verbose=False):
        '''
        denoise score matching (DSM) in transformed space then back to original space
        Args:
        - data:     [ ndata, ndim ] np, raw data
        - sigma:    noise standard deviation in denoising score matching
        '''
        # fit base parameter
        if len(data) == 0 or data.shape[1] != self.ndim:
            self.base.data = torch.zeros(self.ndim).float()
        else:
            # NOTE (GP background): previously mu was a single global density
            # (event count / bounding-box volume), which implicitly assumes a
            # spatially-homogeneous (constant-rate) background. Now that the
            # background rate is a Gaussian process, that global average is
            # biased -- too low in the GP's high-intensity regions and too high
            # in its low-intensity ones -- which gives the zero-initialized `ff`
            # network a worse starting point via `base`. We instead estimate a
            # locally-adaptive density with a Gaussian KDE over the spatial
            # coordinates and summarize it with the median (robust to a few
            # high-density clusters), rather than one volume-averaged number.
            # This only changes the *initialization*; `ff` still learns the
            # remaining spatial structure during training.
            try:
                kde = gaussian_kde(data[:, 1:].T)
                local_density = kde(data[:, 1:].T) * len(data)   # [ ndata ] np, local rate estimate
                mu = np.median(local_density)
            except (np.linalg.LinAlgError, ValueError):
                # KDE can fail on too few / degenerate (duplicate) points;
                # fall back to the old global-volume estimate in that case.
                vol = np.prod(np.diff([[data[:, i].min(), data[:, i].max()] for i in range(self.ndim)]))
                mu  = len(data) / vol if vol > 0 else 0.0
            base = np.array([
                - mu * 4 * self.radius**2,       # [ 1 ] scalar
                *np.zeros(self.ndim - 1)    # [ ndim - 1 ] np
            ])
            self.base.data = torch.from_numpy(base).float()

        if len(data) == 0:   # nothing to train on: find_index() raises on empty input (reached via detect.online refits)
            return None

        # fit networks
        data_tr = self.localize(data)               # [ ndata, ndim ] np
        data_tr = torch.from_numpy(data_tr).float() # [ ndata, ndim ]
        dataset = TensorDataset(data_tr)
        dataloader = DataLoader(dataset, batch_size=batch_size, shuffle=True)
        optimizer = torch.optim.Adam(self.parameters(), lr=lr)
        loss_list = []
        for epoch in range(n_epochs):
            loss_batch_list = []
            for batch in dataloader:
                batch = batch[0]        # [ batch_size, ndim ] torch
                if self.use_transform:
                    batch = self.transform(batch)       # [ batch_size, ndim ] torch
                eps   = torch.randn_like(batch) * sigma # [ batch_size, ndim ] torch
                score = self(batch + eps, is_training=True)  # [ batch_size, ndim ] torch
                loss  = torch.mean(torch.linalg.norm(score + eps / sigma**2, ord=2, dim=1)**2) # torch scalar
                optimizer.zero_grad()
                loss.backward()
                optimizer.step()
                loss_batch_list.append(loss.item())
            loss_list.append(np.mean(loss_batch_list))

            if epoch % (max(n_epochs, 10) // 10) == 0 and verbose: # print loss every 10% epochs
                print(f'Epoch {epoch}/{n_epochs}, Loss: {loss_list[-1]:.4f}')

        # save model
        if save_folder is not None:
            os.makedirs(save_folder, exist_ok=True)
            torch.save(self.state_dict(), save_folder + '/score_model.pt')
        return None
    
    #TODO: Work on this score function to make it more efficient and accurate. Consider using a different architecture or loss function. Also, consider adding regularization to prevent overfitting.
    def __call__(self, data, is_training=False):
        '''
        Stein score function (torch version)
        Args:
        - data:     [ ndata, ndim ] torch, localized data
        - is_training: whether in training mode (affects the use of transform)
        Output:
        - score:    [ ndata, ndim ] torch
        '''
        if self.use_transform:
            if is_training:
                nn  = self.ff(torch.cat([data, self.rn(data)[0]], dim=1)) # [ ndata, ndim ] torch
                out = nn
            else:
                nn  = self.ff(torch.cat([data, self.rn(data)[0]], dim=1)) # [ ndata, ndim ] torch
                out = self.inverse_transform_score(data, nn)
        else:
            base = self.base.repeat(data.shape[0], 1)   # [ ndata, ndim ] torch
            nn  = self.ff(torch.cat([data, self.rn(data)[0]], dim=1)) # [ ndata, ndim ] torch
            out = base + nn
        return out # [ ndata, ndim ] torch
    
    def load(self, save_folder):
        path = save_folder + '/score_model.pt'
        state_dict = torch.load(path)
        self.load_state_dict(state_dict)
    
    def localize(self, data):
        '''
        Args:
        - data:     [ ndata, ndim ] np, raw data
        Returns:
        - data_loc: [ ndata, ndim ] np
        '''
        index    = self.find_index(data, self.radius)   # [ ndata ] np
        data_loc = data.copy()
        data_loc[:, 0] = data[:, 0] - data[index, 0]    # time
        return data_loc # [ ndata, ndim ] np
    
    def psi(self, data):
        '''
        Weighted Hyvarinen score
        Args:
        - data:     [ ndata, ndim ] np, raw data
        Output:
        - score:    [ ndata ] np
        '''
        data_loc    = self.localize(data)   # [ ndata, ndim ] np
        data_loc    = torch.from_numpy(data_loc).float().requires_grad_(True)
        score       = self(data_loc)                                # [ ndata, ndim ] torch
        term_1 = torch.linalg.norm(torch.sqrt(self.w(data_loc))*score, ord=2, dim=-1)**2 # [ ndata ] torch
        term_2 = 2 * self.div(data_loc, self.w(data_loc)*score)     # [ ndata ] torch
        psi = term_1 + term_2               # [ ndata ] torch
        psi = psi.detach().cpu().numpy()
        return psi # [ ndata ] np
    
    @staticmethod
    def transform(x):
        '''
        Transform data from [0, inf) * [0, 1]^S to R^{S+1}
        Args:
        - x:    [ ndata, ndim ] torch
        Returns:
        - y:    [ ndata, ndim ] torch
        '''
        y = torch.cat([
            torch.log(x[:, :1]),    # time transformation
            torch.logit(x[:, 1:])   # space transformation (identity)
        ], dim=1) # [ ndata, ndim ] torch
        y = torch.clamp(y, min=-1e+5, max=1e+5) # avoid extreme values
        return y
    
    @staticmethod
    def inverse_transform_score(data, y):
        '''
        Inverse transform from R^{S+1} to [0, inf) * [0, 1]^S
        Args:
        - data: [ ndata, ndim ] pt, raw data
        - y:    [ ndata, ndim ] pt, transformed score
        Returns:
        - x:    [ ndata, ndim ] pt, original data
        '''
        x_t = 1 / data[:, 0] * y[:, 0] - 1 / data[:, 0]  # [ ndata ] torch
        x_s = 1 / (data[:, 1:] * (1 - data[:, 1:])) * y[:, 1:] - (1/data[:, 1:] - 1/(1-data[:, 1:])) # [ ndata, ndim-1 ] torch
        x = torch.cat([x_t[:, None], x_s], dim=1) # [ ndata, ndim ] torch
        x = torch.clamp(x, min=-1e+5, max=1e+5) # avoid extreme values
        return x

    @staticmethod
    def w(x):
        '''
        Weighting function
        Args:
        - x:   [ ndata, ndim ] torch 
        Returns:
        - val: [ ndata, ndim ] torch
        '''
        val = torch.cat([
            x[:, :1],
            torch.min(torch.stack([
                x[:, 1:]-0,
                1-x[:, 1:]
            ], dim=2), dim=2).values
        ], dim=1) # weight function
        return val

    @staticmethod
    def find_index(data, radius):
        '''
        Find the index of previous event, who is a delta-neighbor of the current event coordinates
        Args:
        - data:     [ ndata, ndim ] np, raw data
        Returns:
        - index:    [ ndata ] np
        '''
        mat  = cdist(data[:, 1:3], data[:, 1:3])   # [ ndata, ndata ] np, distance matrix
        mat  = np.tril(mat)
        mask = np.logical_or(mat==0., mat>radius) 
        mat  = cdist(np.arange(len(data))[:, None], np.arange(len(data))[:, None])   # [ ndata, ndata ] np, time difference matrix
        mat[mask] = np.inf
        index     = np.argmin(mat, axis=1)
        return index

    @staticmethod
    def div(x, y):
        '''
        Args:
        - x:    [ batch_size, data_dim ] torch, requires grad and is on device
        - y:    [ batch_size, data_dim ] torch
        Returns:
        - div:  [ batch_size ] torch
        '''
        div = []
        for i in range(y.shape[-1]):
            grad = torch.autograd.grad(
                outputs = y[:, i].sum(),
                inputs  = x,
                retain_graph = True,
                create_graph= True
            )[0][:, i]                          # [ batch_size ] th
            div.append(grad)
        div = torch.stack(div, -1).sum(-1)      # [ batch_size ] th
        return div